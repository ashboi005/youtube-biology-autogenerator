/**
 * Pure timeline math. All edits are stored in clip-source seconds; this module
 * turns them into output ("content") time for the renderer.
 */

export type Range = { start: number; end: number };
export type OverlayPosition = "top" | "middle" | "bottom";

export type ClipInput = {
  id: string;
  durationSec: number;
  hasAudio: boolean;
  isHdr: boolean;
  cuts: Range[];
  overlays: (Range & { text: string; position: OverlayPosition })[];
  voiceovers: (Range & { id: string })[];
};

export type PlannedClip = {
  id: string;
  keep: Range[];
  outputOffset: number;
  outputDuration: number;
  hasAudio: boolean;
  isHdr: boolean;
};

export type PlannedOverlay = Range & { text: string; position: OverlayPosition };
/** `srcOffset` = seconds into the voiceover recording where this piece starts. */
export type PlannedVoiceover = Range & { id: string; srcOffset: number };

export type RenderPlan = {
  clips: PlannedClip[];
  contentDuration: number;
  overlays: PlannedOverlay[];
  voiceovers: PlannedVoiceover[];
};

/** Segments shorter than this are treated as empty (avoids 1-frame slivers). */
const MIN_SEGMENT = 0.05;
const EPS = 1e-6;

const round = (n: number) => Math.round(n * 1000) / 1000;

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter((r) => r.end - r.start > EPS)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

export function keepRanges(duration: number, cuts: Range[]): Range[] {
  const clamped = cuts.map((c) => ({
    start: Math.max(0, c.start),
    end: Math.min(duration, c.end),
  }));
  const merged = mergeRanges(clamped);
  const keep: Range[] = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start - cursor >= MIN_SEGMENT) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (duration - cursor >= MIN_SEGMENT) keep.push({ start: cursor, end: duration });
  return keep;
}

type Piece = { out: Range; srcStart: number };

/** Intersect a source range with keep segments, returning each surviving piece in clip-output time. */
function mapPieces(keep: Range[], r: Range): Piece[] {
  const pieces: Piece[] = [];
  let offset = 0;
  for (const k of keep) {
    const s = Math.max(r.start, k.start);
    const e = Math.min(r.end, k.end);
    if (e - s >= MIN_SEGMENT) {
      pieces.push({
        out: { start: round(offset + (s - k.start)), end: round(offset + (e - k.start)) },
        srcStart: s,
      });
    }
    offset += k.end - k.start;
  }
  return pieces;
}

/** Map a source range to output ranges; pieces that become contiguous (a cut removed between them) are merged. */
export function mapRange(keep: Range[], r: Range): Range[] {
  return mergeRanges(mapPieces(keep, r).map((p) => p.out));
}

export function buildPlan(clips: ClipInput[]): RenderPlan {
  const plan: RenderPlan = { clips: [], contentDuration: 0, overlays: [], voiceovers: [] };
  let offset = 0;

  for (const c of clips) {
    const keep = keepRanges(c.durationSec, c.cuts);
    const duration = round(keep.reduce((sum, k) => sum + (k.end - k.start), 0));
    if (duration < MIN_SEGMENT) continue;

    plan.clips.push({
      id: c.id,
      keep,
      outputOffset: round(offset),
      outputDuration: duration,
      hasAudio: c.hasAudio,
      isHdr: c.isHdr,
    });

    for (const o of c.overlays) {
      for (const r of mapRange(keep, o)) {
        plan.overlays.push({
          start: round(offset + r.start),
          end: round(offset + r.end),
          text: o.text,
          position: o.position,
        });
      }
    }

    for (const v of c.voiceovers) {
      for (const p of mapPieces(keep, v)) {
        plan.voiceovers.push({
          id: v.id,
          start: round(offset + p.out.start),
          end: round(offset + p.out.end),
          srcOffset: round(p.srcStart - v.start),
        });
      }
    }

    offset += duration;
  }

  plan.contentDuration = round(offset);
  return plan;
}
