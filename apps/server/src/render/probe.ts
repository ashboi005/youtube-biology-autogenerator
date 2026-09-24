export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  rotation: number;
  isHdr: boolean;
  hasAudio: boolean;
};

type RawStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  color_transfer?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
};
type RawProbe = { format?: { duration?: string }; streams?: RawStream[] };

const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);

export function parseProbe(raw: RawProbe): ProbeResult {
  const video = raw.streams?.find((s) => s.codec_type === "video");
  const duration = Number(raw.format?.duration);
  if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Not a readable video");
  }
  const matrix = video.side_data_list?.find((d) => d.side_data_type === "Display Matrix");
  const rotation = Math.round(matrix?.rotation ?? Number(video.tags?.rotate ?? 0)) || 0;
  const quarterTurn = Math.abs(rotation) % 180 === 90;
  return {
    durationSec: duration,
    width: quarterTurn ? video.height : video.width,
    height: quarterTurn ? video.width : video.height,
    rotation,
    isHdr: HDR_TRANSFERS.has(video.color_transfer ?? ""),
    hasAudio: Boolean(raw.streams?.some((s) => s.codec_type === "audio")),
  };
}

/** Probe a local path or (presigned) URL. ffprobe only reads container headers, so URLs cost a few KB. */
export async function probe(source: string): Promise<ProbeResult> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", source],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed: ${err.trim().slice(-300)}`);
  return parseProbe(JSON.parse(out) as RawProbe);
}
