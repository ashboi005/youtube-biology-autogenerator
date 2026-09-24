/**
 * One-time Backblaze B2 bucket setup.
 *   bun run b2:setup
 *
 * 1. Lifecycle rules via the B2 *native* API (b2_update_bucket):
 *    uploads/ hidden after 15 days, deleted 1 day after hiding; unfinished multipart cancelled after 1 day.
 * 2. CORS via the *S3-compatible* API (PutBucketCors). Rules set in the B2 web UI only apply to
 *    the native API, so browser uploads through S3 presigned URLs need this.
 */
import { GetBucketCorsCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";

import { ENV } from "../src/env.server";
import { s3 } from "../src/storage";

const RETENTION_DAYS = 15;

async function setLifecycle() {
  const auth = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${btoa(`${ENV.B2_KEY_ID}:${ENV.B2_APP_KEY}`)}` },
  });
  if (!auth.ok) throw new Error(`b2_authorize_account failed: ${auth.status} ${await auth.text()}`);
  const a = (await auth.json()) as {
    accountId: string;
    authorizationToken: string;
    apiInfo: { storageApi: { apiUrl: string } };
  };
  const api = (name: string, body: object) =>
    fetch(`${a.apiInfo.storageApi.apiUrl}/b2api/v3/${name}`, {
      method: "POST",
      headers: { Authorization: a.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${name} failed: ${r.status} ${await r.text()}`);
      return r.json() as Promise<Record<string, unknown>>;
    });

  const list = (await api("b2_list_buckets", { accountId: a.accountId, bucketName: ENV.B2_BUCKET })) as {
    buckets: { bucketId: string }[];
  };
  const bucketId = list.buckets[0]?.bucketId;
  if (!bucketId) throw new Error(`Bucket ${ENV.B2_BUCKET} not found (is the key restricted to it?)`);

  await api("b2_update_bucket", {
    accountId: a.accountId,
    bucketId,
    lifecycleRules: [
      {
        fileNamePrefix: "uploads/",
        daysFromUploadingToHiding: RETENTION_DAYS,
        daysFromHidingToDeleting: 1,
        daysFromStartingToCancelingUnfinishedLargeFiles: 1,
      },
    ],
  });
  console.log(`✓ Lifecycle: uploads/ deleted ~${RETENTION_DAYS + 1} days after upload`);
}

async function setCors() {
  await s3().send(
    new PutBucketCorsCommand({
      Bucket: ENV.B2_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [ENV.WEB_URL],
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  const got = await s3().send(new GetBucketCorsCommand({ Bucket: ENV.B2_BUCKET }));
  console.log("✓ CORS:", JSON.stringify(got.CORSRules));
}

await setLifecycle();
await setCors();
