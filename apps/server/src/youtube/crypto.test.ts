import { describe, expect, test } from "bun:test";

import { decrypt, encrypt } from "./crypto";

const KEY = "a".repeat(64);

describe("token crypto", () => {
  test("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("1//refresh-token", KEY);
    const b = encrypt("1//refresh-token", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("1//refresh-token");
  });

  test("tampered ciphertext fails", () => {
    const enc = encrypt("secret", KEY);
    const [iv, tag, data] = enc.split(".");
    const flipped = `${iv}.${tag}.${Buffer.from("xxxxxx").toString("base64url")}`;
    expect(() => decrypt(flipped, KEY)).toThrow();
    expect(data).toBeTruthy();
  });

  test("wrong key fails", () => {
    expect(() => decrypt(encrypt("secret", KEY), "b".repeat(64))).toThrow();
  });
});

import { toYoutubeError } from "./client";

describe("toYoutubeError", () => {
  test("maps revoked token and quota errors", () => {
    expect(toYoutubeError({ response: { data: { error: "invalid_grant" } } }).code).toBe("YOUTUBE_RECONNECT");
    expect(
      toYoutubeError({ response: { data: { error: { errors: [{ reason: "quotaExceeded" }] } } } }).code,
    ).toBe("YOUTUBE_QUOTA");
    expect(toYoutubeError(new Error("boom")).code).toBe("YOUTUBE_OTHER");
  });
});
