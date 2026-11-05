import { describe, expect, test } from "bun:test";

import type { PlannedClip, RenderPlan } from "../timeline";
import { buildAssemblyArgs, buildClipPassArgs, keepExpr, wrapText, type AssemblyInputs } from "./args";

const clip = (over: Partial<PlannedClip> = {}): PlannedClip => ({
  id: "a",
  keep: [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ],
  outputOffset: 0,
  outputDuration: 20,
  hasAudio: true,
  isHdr: false,
  ...over,
});

const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1] ?? "";

describe("buildClipPassArgs (one input per clip — bounded memory)", () => {
  test("single input, cuts removed with select/aselect, exact duration", () => {
    const { args, totalDuration } = buildClipPassArgs({ clip: clip(), inPath: "/w/a.mov", outPath: "/w/p-a.mkv" });
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    const g = graphOf(args);
    expect(g).toContain("select='gte(t,0)*lt(t,10)+gte(t,20)*lt(t,30)'");
    expect(g).toContain("setpts=N/30/TB");
    expect(g).toContain("aselect='gte(t,0)*lt(t,10)+gte(t,20)*lt(t,30)'");
    expect(g).toContain("asetpts=N/SR/TB");
    expect(g).toContain("trim=duration=20");
    expect(g).toContain("atrim=duration=20");
    expect(g).not.toContain("split");
    expect(totalDuration).toBe(20);
    expect(args.at(-1)).toBe("/w/p-a.mkv");
  });

  test("uncut clip skips select entirely", () => {
    const g = graphOf(
      buildClipPassArgs({ clip: clip({ keep: [{ start: 0, end: 30 }], outputDuration: 30 }), inPath: "i", outPath: "o" })
        .args,
    );
    expect(g).not.toContain("select=");
  });

  test("normalizes to 1080p30 yuv420p, downscaling before any tonemap", () => {
    const hdr = graphOf(buildClipPassArgs({ clip: clip({ isHdr: true }), inPath: "i", outPath: "o" }).args);
    expect(hdr).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(hdr).toContain("tonemap=tonemap=hable");
    expect(hdr.indexOf("scale=1920")).toBeLessThan(hdr.indexOf("tonemap"));
    expect(hdr).toContain("fps=30");
    expect(hdr).toContain("format=yuv420p");
    const sdr = graphOf(buildClipPassArgs({ clip: clip(), inPath: "i", outPath: "o" }).args);
    expect(sdr).not.toContain("tonemap");
  });

  test("clip without audio gets generated silence of exact length", () => {
    const g = graphOf(buildClipPassArgs({ clip: clip({ hasAudio: false }), inPath: "i", outPath: "o" }).args);
    expect(g).toContain("anullsrc=r=48000:cl=stereo");
    expect(g).not.toContain("[0:a]");
  });

  test("intermediate is high quality, low-load", () => {
    const joined = buildClipPassArgs({ clip: clip(), inPath: "i", outPath: "o" }).args.join(" ");
    expect(joined).toContain("-c:v libx264 -preset veryfast -crf 17");
    expect(joined).toContain("-threads 3");
    expect(joined).toContain("-c:a flac");
  });
});

const plan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  clips: [clip(), clip({ id: "b", outputOffset: 20, outputDuration: 5, keep: [{ start: 0, end: 5 }] })],
  contentDuration: 25,
  overlays: [],
  voiceovers: [],
  ...over,
});

const assembly = (over: Partial<AssemblyInputs> = {}): AssemblyInputs => ({
  plan: plan(),
  segmentPaths: { a: "/w/p-a.mkv", b: "/w/p-b.mkv" },
  voPaths: { v1: "/w/v1.m4a" },
  fadeSeconds: 1,
  fontPath: "/fonts/Bold.ttf",
  workDir: "/w",
  outPath: "/w/final.mp4",
  audioCleanup: true,
  ...over,
});

describe("buildAssemblyArgs", () => {
  test("content is one concat-demuxer input listing segments in order", () => {
    const { args, textFiles } = buildAssemblyArgs(assembly());
    expect(args.join(" ")).toContain("-f concat -safe 0 -i /w/segments.txt");
    expect(textFiles).toContainEqual({ path: "/w/segments.txt", content: "file '/w/p-a.mkv'\nfile '/w/p-b.mkv'\n" });
  });

  test("uses the low-load final encoder settings", () => {
    const joined = buildAssemblyArgs(assembly()).args.join(" ");
    expect(joined).toContain("-c:v libx264 -preset veryfast -crf 20");
    expect(joined).toContain("-threads 3");
    expect(joined).toContain("-c:a aac -b:a 192k");
    expect(joined).toContain("-movflags +faststart");
  });

  test("one drawtext per overlay, in content time, text via textfile", () => {
    const { args, textFiles } = buildAssemblyArgs(
      assembly({
        plan: plan({
          overlays: [
            { start: 2, end: 6, text: `It's 50% "easy": C:\\path`, position: "top" },
            { start: 8, end: 9, text: "Second", position: "bottom" },
          ],
        }),
      }),
    );
    const g = graphOf(args);
    expect(g.match(/drawtext=/g)?.length).toBe(2);
    expect(g).toContain("enable='between(t,2,6)'");
    expect(g).toContain("textfile=/w/overlay-0.txt");
    expect(g).toContain("expansion=none");
    expect(textFiles).toContainEqual({ path: "/w/overlay-0.txt", content: `It's 50% "easy": C:\\path` });
  });

  test("voiceover mutes original and mixes the seeked recording, padded/trimmed to its range", () => {
    const { args } = buildAssemblyArgs(
      assembly({ plan: plan({ voiceovers: [{ id: "v1", start: 12, end: 15.5, srcOffset: 2 }] }) }),
    );
    const g = graphOf(args);
    expect(args.join(" ")).toContain("-ss 2 -t 3.5 -i /w/v1.m4a");
    expect(g).toContain("volume=0:enable='between(t,12,15.5)'");
    expect(g).toContain("apad,atrim=duration=3.5");
    expect(g).toContain("adelay=delays=12000:all=1");
    expect(g).toContain("amix=inputs=2:normalize=0:duration=first");
  });

  test("audio cleanup on/off", () => {
    expect(graphOf(buildAssemblyArgs(assembly()).args)).toContain(
      "highpass=f=80,afftdn=nr=10:nf=-40,loudnorm=I=-14:TP=-1.5:LRA=11",
    );
    expect(graphOf(buildAssemblyArgs(assembly({ audioCleanup: false })).args)).not.toContain("loudnorm");
  });

  test("no intro/outro: no xfade, total = content", () => {
    const { args, totalDuration } = buildAssemblyArgs(assembly());
    expect(graphOf(args)).not.toContain("xfade");
    expect(totalDuration).toBe(25);
  });

  test("intro crossfades into content; outro crossfades out", () => {
    const { args, totalDuration } = buildAssemblyArgs(
      assembly({
        intro: { path: "/a/intro.mp4", duration: 5, hasAudio: true },
        outro: { path: "/a/outro.mp4", duration: 4, hasAudio: false },
      }),
    );
    const g = graphOf(args);
    expect(g).toContain("xfade=transition=fade:duration=1:offset=4");
    // first xfade output is 5 + 25 - 1 = 29s, so outro starts at 28
    expect(g).toContain("xfade=transition=fade:duration=1:offset=28");
    expect(g.match(/acrossfade=d=1/g)?.length).toBe(2);
    expect(totalDuration).toBe(32);
  });

  test("fade is clamped when intro is shorter than twice the fade", () => {
    const { args, totalDuration } = buildAssemblyArgs(
      assembly({ intro: { path: "/a/intro.mp4", duration: 1, hasAudio: true } }),
    );
    expect(graphOf(args)).toContain("xfade=transition=fade:duration=0.5:offset=0.5");
    expect(totalDuration).toBe(25.5);
  });
});

describe("keepExpr / wrapText", () => {
  test("keepExpr joins half-open ranges", () => {
    expect(keepExpr([{ start: 1.5, end: 3 }])).toBe("gte(t,1.5)*lt(t,3)");
  });

  test("wraps long lines on word boundaries", () => {
    expect(wrapText("The three phases of the cell cycle explained simply", 20)).toBe(
      "The three phases of\nthe cell cycle\nexplained simply",
    );
  });
});
