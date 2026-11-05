import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ENV } from "../env.server";

export * from "./keys";

let client: S3Client | undefined;

function bucket() {
  if (!ENV.B2_BUCKET) throw new Error("B2 storage is not configured (B2_BUCKET missing)");
  return ENV.B2_BUCKET;
}

export function s3(): S3Client {
  if (client) return client;
  if (!ENV.B2_ENDPOINT || !ENV.B2_KEY_ID || !ENV.B2_APP_KEY || !ENV.B2_REGION) {
    throw new Error("B2 storage is not configured (B2_ENDPOINT/B2_REGION/B2_KEY_ID/B2_APP_KEY)");
  }
  client = new S3Client({
    endpoint: ENV.B2_ENDPOINT,
    region: ENV.B2_REGION,
    credentials: { accessKeyId: ENV.B2_KEY_ID, secretAccessKey: ENV.B2_APP_KEY },
    // Path-style works on B2 and on local S3 stand-ins (MinIO) alike.
    forcePathStyle: true,
    // B2 doesn't support the SDK's default CRC32 checksums on presigned/multipart requests.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

const PRESIGN_SECONDS = 3600;

export async function createMultipart(key: string, contentType: string): Promise<string> {
  const res = await s3().send(
    new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
  );
  if (!res.UploadId) throw new Error("B2 did not return an UploadId");
  return res.UploadId;
}

export function signPart(key: string, uploadId: string, partNumber: number): Promise<string> {
  return getSignedUrl(
    s3(),
    new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: PRESIGN_SECONDS },
  );
}

export async function listParts(key: string, uploadId: string) {
  const res = await s3().send(new ListPartsCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
  return (res.Parts ?? []).map((p) => ({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: p.Size! }));
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
): Promise<void> {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
    }),
  );
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await s3().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
}

export function presignGet(key: string, expiresIn = PRESIGN_SECONDS): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn });
}

export function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), {
    expiresIn: PRESIGN_SECONDS,
  });
}

/** Stream an object to disk (never buffered in memory). */
export async function downloadToFile(key: string, path: string): Promise<void> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`Empty object: ${key}`);
  const readable =
    body instanceof Readable ? body : Readable.fromWeb((body as { transformToWebStream(): ReadableStream }).transformToWebStream() as never);
  await pipeline(readable, createWriteStream(path));
}

export async function headExists(key: string): Promise<boolean> {
  try {
    await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: "bytes=0-0" }));
    return true;
  } catch {
    return false;
  }
}
