import type { OverlayPosition, PlannedClip, Range, RenderPlan } from "../timeline";

/**
 * Two-pass render, sized for a small VPS:
 *  1. `buildClipPassArgs` — one ffmpeg run per clip, ONE input, cuts removed with select/aselect,
 *     normalized to a 1080p30 intermediate. Only one full-resolution decoder is ever open.
 *  2. `buildAssemblyArgs` — intermediates joined with the concat *demuxer* (sequential, one input),
 *     then text overlays, voice swaps, audio cleanup and intro/outro crossfades.
 * (One input per cut segment looked cheaper but ffmpeg buffers frames per open input → OOM.)
 */

export type Bumper = { path: string; duration: number; hasAudio: boolean };

export type FfmpegCommand = {
  args: string[];
  totalDuration: number;
  textFiles: { path: string; content: string }[];
};

const W = 1920;
const H = 1080;
const FPS = 30;
const AUDIO_FMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
const AUDIO_CLEANUP = "highpass=f=80,afftdn=nr=10:nf=-40,loudnorm=I=-14:TP=-1.5:LRA=11";
const SCALE = `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
// Runs after the downscale: tonemapping 4K float frames is slow and memory-hungry.
const TONEMAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";
const PAD_FPS = `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;

const WRAP_CHARS = 32;
const TEXT_Y: Record<OverlayPosition, string> = {
  top: "h*0.08",
  middle: "(h-text_h)/2",
  bottom: "h*0.88-text_h",
};

const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** Escape a value used inside a filter option (paths). */
function escapeOption(v: string) {
  return v.replace(/\\/g, "\\\\\\\\").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
}

export function wrapText(text: string, width = WRAP_CHARS): string {
  return text
    .split("\n")
    .map((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        if (cur && cur.length + 1 + w.length > width) {
          lines.push(cur);
          cur = w;
        } else {
          cur = cur ? `${cur} ${w}` : w;
        }
      }
      if (cur) lines.push(cur);
      return lines.join("\n");
    })
    .join("\n");
}

/** select/aselect expression keeping half-open ranges [start, end). */
export const keepExpr = (keep: Range[]) => keep.map((k) => `gte(t,${num(k.start)})*lt(t,${num(k.end)})`).join("+");

const x264 = (crf: number) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-threads", "3"];

// ---------------------------------------------------------------- pass 1

export function buildClipPassArgs(i: { clip: PlannedClip; inPath: string; outPath: string }): FfmpegCommand {
  const { clip } = i;
  const d = num(clip.outputDuration);
  const whole = clip.keep.length === 1 && clip.keep[0]!.start === 0;
  const expr = keepExpr(clip.keep);

  const video = [
    SCALE,
    clip.isHdr ? TONEMAP : null,
    PAD_FPS,
    whole ? `trim=start=${num(clip.keep[0]!.start)}` : `select='${expr}'`,
    `setpts=N/${FPS}/TB`,
    "format=yuv420p",
    `trim=duration=${d}`,
  ]
    .filter(Boolean)
    .join(",");

  const audio = clip.hasAudio
    ? `[0:a]aresample=48000,${AUDIO_FMT},${whole ? "" : `aselect='${expr}',`}asetpts=N/SR/TB,apad,atrim=duration=${d}[a]`
    : `anullsrc=r=48000:cl=stereo,${AUDIO_FMT},atrim=duration=${d}[a]`;

  const args = [
    "-i",
    i.inPath,
    "-filter_complex",
    `[0:v]${video}[v];${audio}`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...x264(17),
    "-c:a",
    "flac",
    "-y",
    i.outPath,
  ];
  return { args, totalDuration: clip.outputDuration, textFiles: [] };
}

// ---------------------------------------------------------------- pass 2

export type AssemblyInputs = {
  plan: RenderPlan;
  /** Pass-1 intermediate per planned clip id. */
  segmentPaths: Record<string, string>;
  voPaths: Record<string, string>;
  intro?: Bumper;
  outro?: Bumper;
  fadeSeconds: number;
  fontPath: string;
  workDir: string;
  outPath: string;
  audioCleanup: boolean;
};

export function buildAssemblyArgs(i: AssemblyInputs): FfmpegCommand {
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const textFiles: FfmpegCommand["textFiles"] = [];
  let inputIndex = 0;

  const addInput = (path: string, opts: string[] = []) => {
    inputArgs.push(...opts, "-i", path);
    return inputIndex++;
  };

  // --- content: every intermediate through a single concat-demuxer input ---
  if (i.plan.clips.length === 0) throw new Error("Nothing to render: every clip is fully cut");
  const listPath = `${i.workDir}/segments.txt`;
  textFiles.push({
    path: listPath,
    content: i.plan.clips
      .map((c) => {
        const p = i.segmentPaths[c.id];
        if (!p) throw new Error(`Missing intermediate for clip ${c.id}`);
        return `file '${p.replace(/'/g, "'\\''")}'\n`;
      })
      .join(""),
  });
  addInput(listPath, ["-f", "concat", "-safe", "0"]);

  // --- text overlays (content time) ---
  let videoLabel = "0:v";
  if (i.plan.overlays.length) {
    const draws = i.plan.overlays.map((o, idx) => {
      const path = `${i.workDir}/overlay-${idx}.txt`;
      textFiles.push({ path, content: wrapText(o.text) });
      return [
        `drawtext=fontfile=${escapeOption(i.fontPath)}`,
        `textfile=${escapeOption(path)}`,
        "expansion=none",
        "fontsize=64",
        "fontcolor=white",
        "line_spacing=12",
        "text_align=C",
        "box=1",
        "boxcolor=black@0.55",
        "boxborderw=24",
        "x=(w-text_w)/2",
        `y=${TEXT_Y[o.position]}`,
        `enable='between(t,${num(o.start)},${num(o.end)})'`,
      ].join(":");
    });
    filters.push(`[0:v]${draws.join(",")}[cv1]`);
    videoLabel = "cv1";
  }
  filters.push(`[${videoLabel}]settb=1/${FPS}[cv]`);

  // --- voiceovers: mute original in range, mix recording in ---
  filters.push(`[0:a]${AUDIO_FMT}[ca0]`);
  let audioLabel = "ca0";
  if (i.plan.voiceovers.length) {
    const enable = i.plan.voiceovers.map((v) => `between(t,${num(v.start)},${num(v.end)})`).join("+");
    filters.push(`[ca0]volume=0:enable='${enable}'[cam]`);
    const voLabels = i.plan.voiceovers.map((v, idx) => {
      const path = i.voPaths[v.id];
      if (!path) throw new Error(`Missing local path for voiceover ${v.id}`);
      const len = num(v.end - v.start);
      const n = addInput(path, ["-ss", num(v.srcOffset), "-t", len]);
      filters.push(
        `[${n}:a]aresample=48000,${AUDIO_FMT},apad,atrim=duration=${len},asetpts=PTS-STARTPTS,` +
          `adelay=delays=${Math.round(v.start * 1000)}:all=1[vo${idx}]`,
      );
      return `[vo${idx}]`;
    });
    filters.push(`[cam]${voLabels.join("")}amix=inputs=${voLabels.length + 1}:normalize=0:duration=first[camix]`);
    audioLabel = "camix";
  }
  filters.push(`[${audioLabel}]${i.audioCleanup ? `${AUDIO_CLEANUP},aresample=48000,` : ""}${AUDIO_FMT}[ca]`);

  // --- intro / outro crossfades ---
  const content = i.plan.contentDuration;
  let fade = i.fadeSeconds;
  for (const b of [i.intro, i.outro]) if (b) fade = Math.min(fade, b.duration / 2);
  if (i.intro || i.outro) fade = Math.min(fade, content / 2);

  const bumper = (b: Bumper, label: string) => {
    const n = addInput(b.path);
    const d = num(b.duration);
    filters.push(`[${n}:v]${SCALE},${PAD_FPS},format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS,settb=1/${FPS}[${label}v]`);
    filters.push(
      `${b.hasAudio ? `[${n}:a]aresample=48000,` : "anullsrc=r=48000:cl=stereo,"}${AUDIO_FMT},apad,atrim=duration=${d},asetpts=PTS-STARTPTS[${label}a]`,
    );
  };

  let v = "cv";
  let a = "ca";
  let length = content;
  if (i.intro) {
    bumper(i.intro, "in");
    filters.push(`[inv][${v}]xfade=transition=fade:duration=${num(fade)}:offset=${num(i.intro.duration - fade)}[xv1]`);
    filters.push(`[ina][${a}]acrossfade=d=${num(fade)}[xa1]`);
    v = "xv1";
    a = "xa1";
    length = i.intro.duration + length - fade;
  }
  if (i.outro) {
    bumper(i.outro, "out");
    filters.push(`[${v}][outv]xfade=transition=fade:duration=${num(fade)}:offset=${num(length - fade)}[xv2]`);
    filters.push(`[${a}][outa]acrossfade=d=${num(fade)}[xa2]`);
    v = "xv2";
    a = "xa2";
    length = length + i.outro.duration - fade;
  }

  const args = [
    ...inputArgs,
    "-filter_complex",
    filters.join(";"),
    "-filter_complex_threads",
    "3",
    "-map",
    `[${v}]`,
    "-map",
    `[${a}]`,
    ...x264(20),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-y",
    i.outPath,
  ];
  return { args, totalDuration: Math.round(length * 1000) / 1000, textFiles };
}
