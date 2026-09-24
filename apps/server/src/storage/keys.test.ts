import { describe, expect, test } from "bun:test";

import { clipKey, extOf, isProjectKey, thumbKey, voKey } from "./keys";

describe("storage keys", () => {
  test("builds the documented key layout", () => {
    expect(clipKey("p1", "c1", "IMG_0042.MOV")).toBe("uploads/p1/clips/c1.mov");
    expect(voKey("p1", "v1", "audio/mp4")).toBe("uploads/p1/vo/v1.m4a");
    expect(voKey("p1", "v1", "audio/webm;codecs=opus")).toBe("uploads/p1/vo/v1.webm");
    expect(thumbKey("p1")).toBe("uploads/p1/thumb.jpg");
  });

  test("extension is sanitized", () => {
    expect(extOf("../../evil.m$ov")).toBe("mov");
    expect(extOf("noext")).toBe("bin");
  });

  test("project key ownership check rejects other projects and traversal", () => {
    expect(isProjectKey("p1", "uploads/p1/clips/c1.mov")).toBe(true);
    expect(isProjectKey("p1", "uploads/p10/clips/c1.mov")).toBe(false);
    expect(isProjectKey("p1", "uploads/p1/../p2/clips/c1.mov")).toBe(false);
    expect(isProjectKey("p1", "assets/intro.mp4")).toBe(false);
  });
});
