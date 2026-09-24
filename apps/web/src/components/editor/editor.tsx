"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, Spinner } from "@/components/ui";
import { api, putWithProgress } from "@/lib/api";
import { fmtTime, type Clip, type Position, type Voiceover } from "@/lib/types";
import { localFiles } from "@/lib/uploader";

import { Timeline } from "./timeline";

type Mode =
  | { kind: "idle" }
  | { kind: "cut"; start: number }
  | { kind: "text"; start: number; end: number; text: string; position: Position }
  | { kind: "countdown"; start: number; n: number }
  | { kind: "recording"; start: number }
  | { kind: "saving" };

const TEXT_SECONDS = 4;
const OVERLAY_POS: Record<Position, string> = {
  top: "top-[8%]",
  middle: "top-1/2 -translate-y-1/2",
  bottom: "bottom-[12%]",
};

/** Freshly recorded voiceovers play from memory; older ones are fetched once. */
const voiceUrls = new Map<string, string>();

export function Editor({ clip, refresh }: { clip: Clip; refresh: () => Promise<void> }) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const duration = clip.durationSec ?? 0;
  const recordingRef = useRef(false);
  recordingRef.current = mode.kind === "recording" || mode.kind === "countdown";

  // Prefer the file still on the phone (no download); otherwise stream from storage.
  useEffect(() => {
    const file = localFiles.get(clip.id);
    if (file) {
      const url = URL.createObjectURL(file);
      setSrc(url);
      return () => URL.revokeObjectURL(url);
    }
    let cancelled = false;
    api<{ url: string }>(`/clips/${clip.id}/url`)
      .then((r) => !cancelled && setSrc(r.url))
      .catch((e) => toast.error(e.message));
    return () => {
      cancelled = true;
    };
  }, [clip.id]);

  const voiceAt = useCallback(
    (time: number) => clip.voiceovers.find((v) => v.ready && time >= v.startSec && time < v.endSec),
    [clip.voiceovers],
  );

  // Preview loop: skip cuts, swap in re-recorded voice.
  useEffect(() => {
    let raf = 0;
    let activeVoice: Voiceover | undefined;
    const tick = () => {
      const v = video.current;
      if (v) {
        const now = v.currentTime;
        setT(now);
        if (!recordingRef.current && !v.paused) {
          const cut = clip.cuts.find((c) => now >= c.startSec && now < c.endSec - 0.05);
          if (cut) v.currentTime = cut.endSec;

          const voice = voiceAt(now);
          const a = audio.current;
          if (voice !== activeVoice) {
            activeVoice = voice;
            if (a) a.pause();
            v.muted = Boolean(voice);
            if (voice && a) {
              void playVoice(a, voice, now - voice.startSec);
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clip.cuts, voiceAt]);

  const seek = (time: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, time));
    setT(v.currentTime);
  };

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else {
      v.pause();
      audio.current?.pause();
    }
  };

  const save = async (fn: () => Promise<unknown>) => {
    setMode({ kind: "saving" });
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setMode({ kind: "idle" });
  };

  const del = (path: string) => save(() => api(path, { method: "DELETE" }));

  // ---- re-record voice ----
  const startRecording = async () => {
    const v = video.current;
    if (!v) return;
    v.pause();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
    } catch {
      toast.error("Allow microphone access to re-record");
      return;
    }
    const start = v.currentTime;
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const end = Math.min(duration, v.currentTime);
      v.muted = false;
      const type = (rec.mimeType || mime || "audio/mp4").split(";")[0]!;
      const blob = new Blob(chunks, { type });
      if (end - start < 0.3) {
        setMode({ kind: "idle" });
        toast.error("That recording was too short");
        return;
      }
      void save(async () => {
        const r = await api<{ voiceover: Voiceover; uploadUrl: string }>(`/clips/${clip.id}/voiceovers`, {
          body: { startSec: start, endSec: end, contentType: type },
        });
        await putWithProgress(r.uploadUrl, blob, type);
        await api(`/voiceovers/${r.voiceover.id}/complete`, { body: {} });
        voiceUrls.set(r.voiceover.id, URL.createObjectURL(blob));
        toast.success("New voice saved");
      });
    };
    recorder.current = rec;

    for (let n = 3; n > 0; n--) {
      setMode({ kind: "countdown", start, n });
      await new Promise((r) => setTimeout(r, 1000));
    }
    v.muted = true;
    v.currentTime = start;
    rec.start();
    setMode({ kind: "recording", start });
    await v.play();
    v.onended = () => rec.state === "recording" && rec.stop();
  };

  const stopRecording = () => {
    video.current?.pause();
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  const overlayNow = clip.overlays.find((o) => t >= o.startSec && t < o.endSec);
  const draftText = mode.kind === "text" && mode.text ? mode : null;
  const shownText = draftText ?? overlayNow;

  return (
    <div className="flex flex-col gap-4">
      <div className="relative overflow-hidden rounded-2xl bg-ink">
        {src ? (
          <video
            ref={video}
            src={src}
            playsInline
            preload="metadata"
            className="aspect-video w-full"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : (
          <div className="aspect-video">
            <Spinner label="Loading video…" />
          </div>
        )}
        {shownText && (
          <div
            className={`pointer-events-none absolute inset-x-4 flex justify-center ${OVERLAY_POS[shownText.position]}`}
          >
            <span className="rounded-lg bg-black/55 px-3 py-1.5 text-center text-[clamp(14px,4.5vw,28px)] leading-tight font-bold whitespace-pre-line text-white">
              {shownText.text}
            </span>
          </div>
        )}
        {mode.kind === "countdown" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 font-display text-8xl font-bold text-white">
            {mode.n}
          </div>
        )}
        {mode.kind === "recording" && (
          <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-eosin px-3 py-1 font-semibold text-white">
            <span className="size-2.5 animate-pulse rounded-full bg-white" /> Recording
          </div>
        )}
      </div>
      <audio ref={audio} preload="none" />

      <Timeline
        duration={duration}
        time={t}
        cuts={clip.cuts}
        overlays={clip.overlays}
        voiceovers={clip.voiceovers}
        pendingStart={mode.kind === "cut" || mode.kind === "text" ? mode.start : null}
        onSeek={seek}
        disabled={mode.kind === "recording" || mode.kind === "countdown"}
      />

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <Button tone="plain" onClick={() => seek(t - 1)} aria-label="Back one second">
          −1s
        </Button>
        <Button onClick={togglePlay} className="min-w-28" disabled={!src || mode.kind === "recording"}>
          {playing ? "Pause" : "Play"}
        </Button>
        <Button tone="plain" onClick={() => seek(t + 1)} aria-label="Forward one second">
          +1s
        </Button>
      </div>
      <p className="text-center font-display text-lg tabular-nums">
        {fmtTime(t)} <span className="text-ink-soft">/ {fmtTime(duration)}</span>
      </p>

      {mode.kind === "idle" && (
        <div className="grid grid-cols-1 gap-2">
          <Button big tone="eosin" onClick={() => setMode({ kind: "cut", start: t })}>
            Cut a part out
          </Button>
          <Button
            big
            onClick={() =>
              setMode({ kind: "text", start: t, end: Math.min(duration, t + TEXT_SECONDS), text: "", position: "bottom" })
            }
          >
            Add text
          </Button>
          <Button big tone="plain" onClick={startRecording}>
            Re-record voice from here
          </Button>
        </div>
      )}

      {mode.kind === "cut" && (
        <div className="flex flex-col gap-3 rounded-2xl bg-eosin-soft p-4">
          <p>
            Cut starts at <b>{fmtTime(mode.start)}</b>. Play or drag to where the mistake ends, then tap “End cut
            here”.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button tone="plain" onClick={() => setMode({ kind: "idle" })}>
              Cancel
            </Button>
            <Button
              tone="eosin"
              disabled={t - mode.start < 0.1}
              onClick={() =>
                save(() => api(`/clips/${clip.id}/cuts`, { body: { startSec: mode.start, endSec: t } }))
              }
            >
              End cut here
            </Button>
          </div>
        </div>
      )}

      {mode.kind === "text" && (
        <div className="flex flex-col gap-3 rounded-2xl bg-violet-soft p-4">
          <input
            autoFocus
            maxLength={120}
            value={mode.text}
            placeholder="Type the text to show"
            onChange={(e) => setMode({ ...mode, text: e.target.value })}
            className="min-h-14 rounded-2xl border-2 border-line bg-surface px-4 text-lg"
          />
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Where on screen">
            {(["top", "middle", "bottom"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={mode.position === p}
                onClick={() => setMode({ ...mode, position: p })}
                className={`min-h-12 rounded-2xl border-2 font-semibold capitalize ${
                  mode.position === p ? "border-violet bg-violet text-white" : "border-line bg-surface"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <p>
            Shows from <b>{fmtTime(mode.start)}</b> to <b>{fmtTime(mode.end)}</b>.
          </p>
          <Button
            tone="plain"
            disabled={t - mode.start < 0.1}
            onClick={() => setMode({ ...mode, end: t })}
          >
            End text here ({fmtTime(t)})
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button tone="plain" onClick={() => setMode({ kind: "idle" })}>
              Cancel
            </Button>
            <Button
              disabled={!mode.text.trim()}
              onClick={() =>
                save(() =>
                  api(`/clips/${clip.id}/overlays`, {
                    body: { startSec: mode.start, endSec: mode.end, text: mode.text, position: mode.position },
                  }),
                )
              }
            >
              Save text
            </Button>
          </div>
        </div>
      )}

      {mode.kind === "recording" && (
        <Button big tone="eosin" onClick={stopRecording}>
          Stop recording
        </Button>
      )}
      {mode.kind === "saving" && <Spinner label="Saving…" />}

      <EditList clip={clip} onSeek={seek} onDelete={del} busy={mode.kind !== "idle"} />
    </div>
  );
}

async function playVoice(a: HTMLAudioElement, v: Voiceover, offset: number) {
  let url = voiceUrls.get(v.id);
  if (!url) {
    try {
      url = (await api<{ url: string }>(`/voiceovers/${v.id}/url`)).url;
      voiceUrls.set(v.id, url);
    } catch {
      return;
    }
  }
  if (a.src !== url) a.src = url;
  a.currentTime = Math.max(0, offset);
  await a.play().catch(() => {});
}

function EditList({
  clip,
  onSeek,
  onDelete,
  busy,
}: {
  clip: Clip;
  onSeek: (t: number) => void;
  onDelete: (path: string) => void;
  busy: boolean;
}) {
  const items = [
    ...clip.cuts.map((c) => ({ id: c.id, start: c.startSec, end: c.endSec, label: "Cut", tone: "bg-eosin", path: `/cuts/${c.id}` })),
    ...clip.overlays.map((o) => ({ id: o.id, start: o.startSec, end: o.endSec, label: `Text “${o.text}”`, tone: "bg-violet", path: `/overlays/${o.id}` })),
    ...clip.voiceovers.map((v) => ({ id: v.id, start: v.startSec, end: v.endSec, label: v.ready ? "New voice" : "New voice (not saved)", tone: "bg-amber", path: `/voiceovers/${v.id}` })),
  ].sort((a, b) => a.start - b.start);

  if (!items.length) return null;
  return (
    <div>
      <h3 className="mb-2 text-lg font-semibold">Changes on this clip</h3>
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.id} className="flex items-center gap-3 rounded-2xl border border-line p-2 pl-4">
            <span className={`size-3 shrink-0 rounded-full ${i.tone}`} aria-hidden />
            <button type="button" className="min-w-0 flex-1 py-1 text-left" onClick={() => onSeek(i.start)}>
              <span className="block truncate">{i.label}</span>
              <span className="block text-sm text-ink-soft tabular-nums">
                {fmtTime(i.start)} – {fmtTime(i.end)}
              </span>
            </button>
            <Button
              tone="plain"
              aria-label={`Delete ${i.label}`}
              disabled={busy}
              onClick={() => window.confirm(`Delete this ${i.label.toLowerCase().split(" ")[0]}?`) && onDelete(i.path)}
            >
              ✕
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
