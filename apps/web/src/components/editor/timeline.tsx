"use client";

import { useRef } from "react";

import type { Cut, Overlay, Voiceover } from "@/lib/types";

type Props = {
  duration: number;
  time: number;
  cuts: Cut[];
  overlays: Overlay[];
  voiceovers: Voiceover[];
  pendingStart: number | null;
  onSeek: (t: number) => void;
  disabled?: boolean;
};

/**
 * The clip as a slide under the microscope: cuts are eosin-stained (hatched),
 * text bands violet, re-recorded voice amber. Tap or drag anywhere to move.
 */
export function Timeline({ duration, time, cuts, overlays, voiceovers, pendingStart, onSeek, disabled }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const pct = (s: number) => `${duration ? (Math.max(0, Math.min(duration, s)) / duration) * 100 : 0}%`;
  const width = (a: number, b: number) => `${duration ? ((Math.min(duration, b) - Math.max(0, a)) / duration) * 100 : 0}%`;

  const seekFromPointer = (clientX: number) => {
    const el = bar.current;
    if (!el || disabled) return;
    const r = el.getBoundingClientRect();
    onSeek(((clientX - r.left) / r.width) * duration);
  };

  return (
    <div
      ref={bar}
      role="slider"
      aria-label="Position in clip"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSeek(time - 1);
        if (e.key === "ArrowRight") onSeek(time + 1);
      }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        seekFromPointer(e.clientX);
      }}
      onPointerMove={(e) => e.buttons && seekFromPointer(e.clientX)}
      className="relative h-20 touch-none select-none rounded-2xl border border-line bg-slide"
    >
      {/* voice lane (bottom) */}
      {voiceovers.map((v) => (
        <div
          key={v.id}
          className="absolute bottom-2 h-4 rounded-full bg-amber"
          style={{ left: pct(v.startSec), width: width(v.startSec, v.endSec) }}
        />
      ))}
      {/* text lane (top) */}
      {overlays.map((o) => (
        <div
          key={o.id}
          className="absolute top-2 h-4 rounded-full bg-violet"
          style={{ left: pct(o.startSec), width: width(o.startSec, o.endSec) }}
        />
      ))}
      {/* cuts span everything: that footage is gone */}
      {cuts.map((c) => (
        <div
          key={c.id}
          className="absolute inset-y-0 bg-eosin/70"
          style={{
            left: pct(c.startSec),
            width: width(c.startSec, c.endSec),
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 6px, rgba(255,255,255,.35) 6px 9px)",
          }}
        />
      ))}
      {pendingStart !== null && time > pendingStart && (
        <div
          className="absolute inset-y-0 border-x-2 border-dashed border-ink/60 bg-ink/10"
          style={{ left: pct(pendingStart), width: width(pendingStart, time) }}
        />
      )}
      <div className="pointer-events-none absolute inset-y-[-6px] w-1 -translate-x-1/2 rounded-full bg-ink" style={{ left: pct(time) }}>
        <div className="absolute -top-1 left-1/2 size-4 -translate-x-1/2 rounded-full border-2 border-surface bg-ink" />
      </div>
    </div>
  );
}
