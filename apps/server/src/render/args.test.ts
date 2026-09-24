import { describe, expect, test } from "bun:test";

import type { RenderPlan } from "../timeline";
import { buildFfmpegArgs, wrapText, type RenderInputs } from "./args";

const basePlan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  clips: [
    {
      id: "a",
      keep: [
        { start: 0, end: 10 },
        { start: 20, end: 30 },
      ],
      outputOffset: 0,
      outputDuration: 20,
      hasAudio: true,
      isHdr: false,
    },
  ],
  contentDuration: 20,
  overlays: [],
  voiceovers: [],
  ...over,
});

const inputs = (over: Partial<RenderInputs> = {}): RenderInputs => ({
  plan: basePlan(),
  clipPaths: { a: "/work/j/a.mov", b: "/work/j/b.mov" },
  voPaths: { v1: "/work/j/v1.m4a" },
  fadeSeconds: 1,
  fontPath: "/fonts/Inter-Bold.ttf",
  workDir: "/work/j",
  outPath: "/work/j/out.mp4",
  audioCleanup: true,
  ...over,
});

const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";

describe("buildFfmpegArgs", () => {
  test("uses the low-load encoder settings", () => {
    const { args } = buildFfmpegArgs(inputs());
    const joined = args.join(" ");
    expect(joined).toContain("-c:v libx264 -preset veryfast -crf 20");
    expect(joined).toContain("-threads 3");
    expect(joined).toContain("-c:a aac -b:a 192k");
    expect(joined).toContain("-movflags +faststart");
    expect(args.at(-1)).toBe("/work/j/out.mp4");
  });

  test("each keep segment is its own seeked input (no split buffering)", () => {
    const { args } = buildFfmpegArgs(inputs());
    expect(args.join(" ")).toContain("-ss 0 -t 10 -i /work/j/a.mov");
    expect(args.join(" ")).toContain("-ss 20 -t 10 -i /work/j/a.mov");
    expect(graphOf(args)).not.toContain("split");
    expect(graphOf(args)).toContain("concat=n=2:v=1:a=1");
  });

  test("normalizes to 1080p30 yuv420p", () => {
    const g = graphOf(buildFfmpegArgs(inputs()).args);
    expect(g).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(g).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
    expect(g).toContain("fps=30");
    expect(g).toContain("format=yuv420p");
  });

  test("HDR clip is tonemapped, SDR clip is not", () => {
    const sdr = graphOf(buildFfmpegArgs(inputs()).args);
    expect(sdr).not.toContain("tonemap");
    const hdrPlan = basePlan();
    hdrPlan.clips[0]!.isHdr = true;
    const hdr = graphOf(buildFfmpegArgs(inputs({ plan: hdrPlan })).args);
    expect(hdr).toContain("tonemap=tonemap=hable");
  });

  test("clip without audio gets generated silence of exact length", () => {
    const plan = basePlan();
    plan.clips[0]!.hasAudio = false;
    const g = graphOf(buildFfmpegArgs(inputs({ plan })).args);
    expect(g).toContain("anullsrc=r=48000:cl=stereo");
    expect(g).not.toContain("[0:a]");
  });

  test("one drawtext per overlay, in content time, text via textfile", () => {
    const plan = basePlan({
      overlays: [
        { start: 2, end: 6, text: `It's 50% "easy": C:\\path`, position: "top" },
        { start: 8, end: 9, text: "Second", position: "bottom" },
      ],
    });
    const { args, textFiles } = buildFfmpegArgs(inputs({ plan }));
    const g = graphOf(args);
    expect(g.match(/drawtext=/g)?.length).toBe(2);
    expect(g).toContain("enable='between(t,2,6)'");
    expect(g).toContain("enable='between(t,8,9)'");
    expect(g).toContain("textfile=/work/j/overlay-0.txt");
    expect(g).toContain("expansion=none");
    expect(textFiles).toContainEqual({
      path: "/work/j/overlay-0.txt",
      content: `It's 50% "easy": C:\\path`,
    });
  });

  test("voiceover mutes original and mixes the seeked recording at its start", () => {
    const plan = basePlan({ voiceovers: [{ id: "v1", start: 12, end: 15.5, srcOffset: 2 }] });
    const { args } = buildFfmpegArgs(inputs({ plan }));
    const g = graphOf(args);
    expect(args.join(" ")).toContain("-ss 2 -t 3.5 -i /work/j/v1.m4a");
    expect(g).toContain("volume=0:enable='between(t,12,15.5)'");
    expect(g).toContain("atrim=duration=3.5");
    expect(g).toContain("adelay=delays=12000:all=1");
    expect(g).toContain("amix=inputs=2:normalize=0:duration=first");
  });

  test("audio cleanup chain is applied when enabled and skipped when disabled", () => {
    const on = graphOf(buildFfmpegArgs(inputs()).args);
    expect(on).toContain("highpass=f=80,afftdn=nr=10:nf=-40,loudnorm=I=-14:TP=-1.5:LRA=11");
    const off = graphOf(buildFfmpegArgs(inputs({ audioCleanup: false })).args);
    expect(off).not.toContain("loudnorm");
  });

  test("no intro/outro: no xfade and total = content", () => {
    const { args, totalDuration } = buildFfmpegArgs(inputs());
    expect(graphOf(args)).not.toContain("xfade");
    expect(totalDuration).toBe(20);
  });

  test("intro crossfades into content; outro crossfades out", () => {
    const { args, totalDuration } = buildFfmpegArgs(
      inputs({
        intro: { path: "/a/intro.mp4", duration: 5, hasAudio: true },
        outro: { path: "/a/outro.mp4", duration: 4, hasAudio: false },
      }),
    );
    const g = graphOf(args);
    expect(g).toContain("xfade=transition=fade:duration=1:offset=4");
    // first xfade output is 5 + 20 - 1 = 24s long, so outro starts at 23
    expect(g).toContain("xfade=transition=fade:duration=1:offset=23");
    expect(g.match(/acrossfade=d=1/g)?.length).toBe(2);
    expect(totalDuration).toBe(27);
  });

  test("fade is clamped when intro is shorter than twice the fade", () => {
    const { args, totalDuration } = buildFfmpegArgs(
      inputs({ intro: { path: "/a/intro.mp4", duration: 1, hasAudio: true } }),
    );
    expect(graphOf(args)).toContain("xfade=transition=fade:duration=0.5:offset=0.5");
    expect(totalDuration).toBe(20.5);
  });
});

describe("wrapText", () => {
  test("wraps long lines on word boundaries", () => {
    expect(wrapText("The three phases of the cell cycle explained simply", 20)).toBe(
      "The three phases of\nthe cell cycle\nexplained simply",
    );
  });

  test("keeps explicit newlines and short text as-is", () => {
    expect(wrapText("Hi\nthere", 20)).toBe("Hi\nthere");
  });
});
