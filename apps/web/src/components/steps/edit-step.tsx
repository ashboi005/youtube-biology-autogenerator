"use client";

import { useEffect, useState } from "react";

import { Editor } from "@/components/editor/editor";
import { ErrorNote } from "@/components/ui";
import type { ProjectDetail } from "@/lib/types";

type Props = { detail: ProjectDetail; refresh: () => Promise<void>; locked: boolean };

export function EditStep({ detail, refresh, locked }: Props) {
  const ready = detail.clips.filter((c) => c.uploadState === "ready");
  const [clipId, setClipId] = useState<string | null>(ready[0]?.id ?? null);

  useEffect(() => {
    if (!ready.some((c) => c.id === clipId)) setClipId(ready[0]?.id ?? null);
  }, [ready, clipId]);

  if (locked) return <ErrorNote>This video is being processed, so edits are paused.</ErrorNote>;
  if (!ready.length) return <p className="text-ink-soft">Once a clip finishes uploading you can edit it here.</p>;

  const clip = ready.find((c) => c.id === clipId) ?? ready[0]!;

  return (
    <div className="flex flex-col gap-4">
      {ready.length > 1 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Choose a clip">
          {ready.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === clip.id}
              onClick={() => setClipId(c.id)}
              className={`min-h-12 shrink-0 rounded-full border-2 px-5 font-semibold ${
                c.id === clip.id ? "border-violet bg-violet text-white" : "border-line bg-surface"
              }`}
            >
              Clip {detail.clips.findIndex((x) => x.id === c.id) + 1}
            </button>
          ))}
        </div>
      )}
      <Editor key={clip.id} clip={clip} refresh={refresh} />
    </div>
  );
}
