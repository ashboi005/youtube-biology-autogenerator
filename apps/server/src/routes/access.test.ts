import { describe, expect, test } from "bun:test";

import { canAccessProject, HttpError, isEditable, validateRange, validateSendable } from "./access";

const editor = { id: "u1", role: "editor" };
const other = { id: "u2", role: "editor" };
const adminUser = { id: "a1", role: "admin" };

describe("canAccessProject", () => {
  test("owner and admin can, other editors cannot", () => {
    const p = { ownerId: "u1" };
    expect(canAccessProject(editor, p)).toBe(true);
    expect(canAccessProject(adminUser, p)).toBe(true);
    expect(canAccessProject(other, p)).toBe(false);
  });
});

describe("isEditable", () => {
  test("locked while queued, rendering or uploading", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("failed")).toBe(true);
    expect(isEditable("done")).toBe(true);
    expect(isEditable("queued")).toBe(false);
    expect(isEditable("rendering")).toBe(false);
    expect(isEditable("uploading")).toBe(false);
  });
});

describe("validateRange", () => {
  test("accepts a range inside the clip", () => {
    expect(() => validateRange(1, 4, 10)).not.toThrow();
  });
  test("rejects inverted, negative, past-end and too-short ranges", () => {
    expect(() => validateRange(4, 1, 10)).toThrow(HttpError);
    expect(() => validateRange(-1, 1, 10)).toThrow(HttpError);
    expect(() => validateRange(1, 11, 10)).toThrow(HttpError);
    expect(() => validateRange(1, 1.01, 10)).toThrow(HttpError);
  });
});

describe("validateSendable", () => {
  const ok = { title: "Mitosis", clips: [{ uploadState: "ready" }], youtube: "connected" as const, status: "draft" };
  test("passes a complete project", () => {
    expect(validateSendable(ok)).toEqual([]);
  });
  test("lists every missing piece in plain English", () => {
    expect(
      validateSendable({ title: " ", clips: [{ uploadState: "uploading" }], youtube: "none", status: "draft" }),
    ).toEqual([
      "Add a title",
      "Wait for all clips to finish uploading",
      "YouTube isn't connected yet (ask admin)",
    ]);
    expect(validateSendable({ ...ok, clips: [] })).toContain("Add at least one clip");
    expect(validateSendable({ ...ok, status: "rendering" })).toContain("This video is already being processed");
  });
});

import { youtubeTextProblems } from "./access";

describe("youtubeTextProblems", () => {
  test("rejects angle brackets YouTube refuses, in plain English", () => {
    expect(youtubeTextProblems("DNA -> RNA", "ok")).toEqual(["Titles can't contain < or > (YouTube rejects them)"]);
    expect(youtubeTextProblems("ok", "a <b>")).toEqual(["Descriptions can't contain < or > (YouTube rejects them)"]);
  });
  test("checks byte length, not character length", () => {
    expect(youtubeTextProblems("ok", "é".repeat(2600))).toEqual(["The description is too long for YouTube"]);
    expect(youtubeTextProblems("ok", "e".repeat(5000))).toEqual([]);
  });
  test("validateSendable includes text problems", () => {
    expect(
      validateSendable({ title: "A > B", description: "", clips: [{ uploadState: "ready" }], youtube: "connected", status: "draft" }),
    ).toContain("Titles can't contain < or > (YouTube rejects them)");
  });
});

import { youtubeState } from "./access";

describe("youtubeState", () => {
  test("revoked connection is not usable and says why", () => {
    expect(youtubeState(null)).toBe("none");
    expect(youtubeState({ needsReconnect: false })).toBe("connected");
    expect(youtubeState({ needsReconnect: true })).toBe("reconnect");
    expect(
      validateSendable({ title: "t", clips: [{ uploadState: "ready" }], youtube: "reconnect", status: "draft" }),
    ).toEqual(["YouTube needs reconnecting (ask admin)"]);
  });
});
