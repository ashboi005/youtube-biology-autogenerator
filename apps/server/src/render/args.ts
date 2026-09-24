import type { OverlayPosition, RenderPlan } from "../timeline";

export type Bumper = { path: string; duration: number; hasAudio: boolean };

export type RenderInputs = {
  plan: RenderPlan;
  clipPaths: Record<string, string>;
  voPaths: Record<string, string>;
  intro?: Bumper;
  outro?: Bumper;
  fadeSeconds: number;
  fontPath: string;
  /** Where per-overlay text files are written (drawtext textfile=). */
  workDir: string;
  outPath: string;
  audioCleanup: boolean;
};

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
const TONEMAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";
const NORMALIZE =
  `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
  `setsar=1,fps=${FPS},format=yuv420p`;

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

export function buildFfmpegArgs(i: RenderInputs): FfmpegCommand {
  const inputArgs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;

  const addInput = (path: string, ss?: number, t?: number) => {
    if (ss !== undefined) inputArgs.push("-ss", num(ss));
    if (t !== undefined) inputArgs.push("-t", num(t));
    inputArgs.push("-i", path);
    return inputIndex++;
  };

  /** Normalized video+audio pair of exact `duration` from input `n`. */
  const normalizedPair = (n: number, duration: number, hasAudio: boolean, hdr: boolean, label: string) => {
    const d = num(duration);
    const v = [hdr ? TONEMAP : null, NORMALIZE, `trim=duration=${d}`, "setpts=PTS-STARTPTS"]
      .filter(Boolean)
      .join(",");
    filters.push(`[${n}:v]${v}[${label}v]`);
    const aSrc = hasAudio ? `[${n}:a]aresample=48000,${AUDIO_FMT},` : `anullsrc=r=48000:cl=stereo,${AUDIO_FMT},`;
    filters.push(`${aSrc}apad,atrim=duration=${d},asetpts=PTS-STARTPTS[${label}a]`);
  };

  // --- content segments ---
  const segLabels: string[] = [];
  let seg = 0;
  for (const c of i.plan.clips) {
    const path = i.clipPaths[c.id];
    if (!path) throw new Error(`Missing local path for clip ${c.id}`);
    for (const k of c.keep) {
      const dur = k.end - k.start;
      const n = addInput(path, k.start, dur);
      const label = `s${seg++}`;
      normalizedPair(n, dur, c.hasAudio, c.isHdr, label);
      segLabels.push(`[${label}v][${label}a]`);
    }
  }
  if (segLabels.length === 0) throw new Error("Nothing to render: every clip is fully cut");
  filters.push(`${segLabels.join("")}concat=n=${segLabels.length}:v=1:a=1[cv0][ca0]`);

  // --- text overlays (content time) ---
  const textFiles: FfmpegCommand["textFiles"] = [];
  let videoLabel = "cv0";
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
    filters.push(`[cv0]${draws.join(",")}[cv1]`);
    videoLabel = "cv1";
  }

  // --- voiceovers: mute original in range, mix recording in ---
  let audioLabel = "ca0";
  if (i.plan.voiceovers.length) {
    const enable = i.plan.voiceovers.map((v) => `between(t,${num(v.start)},${num(v.end)})`).join("+");
    filters.push(`[ca0]volume=0:enable='${enable}'[cam]`);
    const voLabels = i.plan.voiceovers.map((v, idx) => {
      const path = i.voPaths[v.id];
      if (!path) throw new Error(`Missing local path for voiceover ${v.id}`);
      const len = num(v.end - v.start);
      const n = addInput(path, v.srcOffset, v.end - v.start);
      const ms = Math.round(v.start * 1000);
      filters.push(
        `[${n}:a]aresample=48000,${AUDIO_FMT},apad,atrim=duration=${len},asetpts=PTS-STARTPTS,` +
          `adelay=delays=${ms}:all=1[vo${idx}]`,
      );
      return `[vo${idx}]`;
    });
    filters.push(
      `[cam]${voLabels.join("")}amix=inputs=${voLabels.length + 1}:normalize=0:duration=first[camix]`,
    );
    audioLabel = "camix";
  }

  filters.push(
    `[${audioLabel}]${i.audioCleanup ? `${AUDIO_CLEANUP},aresample=48000,` : ""}${AUDIO_FMT}[ca]`,
  );
  filters.push(`[${videoLabel}]settb=1/${FPS}[cv]`);

  // --- intro / outro crossfades ---
  const content = i.plan.contentDuration;
  let fade = i.fadeSeconds;
  for (const b of [i.intro, i.outro]) if (b) fade = Math.min(fade, b.duration / 2);
  if (i.intro || i.outro) fade = Math.min(fade, content / 2);

  let v = "cv";
  let a = "ca";
  let length = content;

  if (i.intro) {
    const n = addInput(i.intro.path);
    normalizedPair(n, i.intro.duration, i.intro.hasAudio, false, "in");
    filters.push(`[inv]settb=1/${FPS}[inv2]`);
    filters.push(`[inv2][${v}]xfade=transition=fade:duration=${num(fade)}:offset=${num(i.intro.duration - fade)}[xv1]`);
    filters.push(`[ina][${a}]acrossfade=d=${num(fade)}[xa1]`);
    v = "xv1";
    a = "xa1";
    length = i.intro.duration + length - fade;
  }

  if (i.outro) {
    const n = addInput(i.outro.path);
    normalizedPair(n, i.outro.duration, i.outro.hasAudio, false, "out");
    filters.push(`[outv]settb=1/${FPS}[outv2]`);
    filters.push(`[${v}][outv2]xfade=transition=fade:duration=${num(fade)}:offset=${num(length - fade)}[xv2]`);
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
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "3",
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
