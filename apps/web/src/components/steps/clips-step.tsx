"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button, ErrorNote, ProgressBar } from "@/components/ui";
import { api } from "@/lib/api";
import type { Clip, ProjectDetail } from "@/lib/types";
import { fmtTime } from "@/lib/types";
import { localFiles, uploadClip, uploadParts } from "@/lib/uploader";

type Props = { detail: ProjectDetail; refresh: () => Promise<void>; locked: boolean };

export function ClipsStep({ detail, refresh, locked }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [pending, setPending] = useState(0);
  const [active, setActive] = useState<Set<string>>(new Set());
  const track = (id: string, on: boolean) =>
    setActive((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const clips = detail.clips;

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files];
    setPending((n) => n + list.length);
    // One file at a time keeps mobile data stable; parts inside a file go in parallel.
    for (const file of list) {
      let clipId: string | null = null;
      try {
        await uploadClip(
          detail.project.id,
          file,
          (clip) => {
            clipId = clip.id;
            track(clip.id, true);
            setPending((n) => n - 1);
            void refresh();
          },
          (f) => clipId && setProgress((p) => ({ ...p, [clipId!]: f })),
        );
      } catch (e) {
        if (!clipId) setPending((n) => n - 1);
        toast.error(`${file.name}: ${(e as Error).message}`);
      }
      if (clipId) track(clipId, false);
      await refresh();
    }
  };

  const retry = async (clip: Clip) => {
    const file = localFiles.get(clip.id);
    if (!file) {
      toast.error("Pick the file again — remove this clip and add it once more");
      return;
    }
    track(clip.id, true);
    try {
      await uploadParts(clip.id, file, (f) => setProgress((p) => ({ ...p, [clip.id]: f })));
    } catch (e) {
      toast.error((e as Error).message);
    }
    track(clip.id, false);
    await refresh();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const ids = clips.map((c) => c.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    await api(`/projects/${detail.project.id}/clips/order`, { method: "PUT", body: { clipIds: ids } });
    await refresh();
  };

  const remove = async (clip: Clip) => {
    if (!window.confirm(`Remove "${clip.originalName}"? Its edits will be removed too.`)) return;
    await api(`/clips/${clip.id}`, { method: "DELETE" });
    localFiles.delete(clip.id);
    await refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {clips.length === 0 && pending === 0 && (
        <p className="text-ink-soft">Add one or more videos from your phone. They play in the order shown here.</p>
      )}

      <ul className="flex flex-col gap-3">
        {clips.map((c, i) => {
          const pct = progress[c.id];
          return (
            <li key={c.id} className="rounded-2xl border border-line p-4">
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slide font-bold">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 font-semibold break-all">{c.originalName}</p>
                  <p className="text-sm text-ink-soft">
                    {c.uploadState === "ready"
                      ? fmtTime(c.durationSec ?? 0).replace(/\.\d$/, "")
                      : c.uploadState === "failed"
                        ? "Couldn't read this file"
                        : "Uploading…"}
                  </p>
                </div>
                {!locked && (
                  <div className="flex shrink-0 gap-1 [&>button]:px-3">
                    <Button tone="plain" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </Button>
                    <Button
                      tone="plain"
                      aria-label="Move down"
                      disabled={i === clips.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button tone="plain" aria-label="Remove clip" onClick={() => remove(c)}>
                      ✕
                    </Button>
                  </div>
                )}
              </div>
              {c.uploadState === "uploading" && (
                <div className="mt-3 flex flex-col gap-2">
                  {active.has(c.id) ? (
                    <ProgressBar value={(pct ?? 0) * 100} />
                  ) : localFiles.has(c.id) ? (
                    <Button tone="plain" onClick={() => retry(c)}>
                      Upload stopped — continue
                    </Button>
                  ) : (
                    <p className="text-sm text-ink-soft">
                      This upload stopped. Remove it (✕) and add the file again.
                    </p>
                  )}
                </div>
              )}
              {c.isHdr && (
                <p className="mt-3 rounded-xl bg-amber-soft px-3 py-2 text-sm">
                  Filmed in HDR. It'll still work, but next time turn off Settings → Camera → Record Video → HDR
                  Video.
                </p>
              )}
            </li>
          );
        })}
        {pending > 0 && <li className="px-1 text-ink-soft">Getting {pending} more ready…</li>}
      </ul>

      {locked ? (
        <ErrorNote>This video is being processed, so clips can't change right now.</ErrorNote>
      ) : (
        <>
          <input
            ref={input}
            type="file"
            accept="video/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button big tone={clips.length ? "plain" : "violet"} onClick={() => input.current?.click()}>
            {clips.length ? "Add more clips" : "Add clips"}
          </Button>
          <p className="text-sm text-ink-soft">Keep this page open until uploads finish.</p>
        </>
      )}
    </div>
  );
}
