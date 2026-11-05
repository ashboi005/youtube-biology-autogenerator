"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button, ErrorNote, ProgressBar } from "@/components/ui";
import { api } from "@/lib/api";
import { isBusy, type ProjectDetail } from "@/lib/types";

type Props = { detail: ProjectDetail; refresh: () => Promise<void> };

const STAGE: Record<string, string> = {
  queued: "Waiting for its turn…",
  rendering: "Making your video",
  uploading: "Sending to YouTube",
};

export function SendStep({ detail, refresh }: Props) {
  const { project, problems } = detail;
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      await api(`/projects/${project.id}/send`, { body: {} });
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (isBusy(project.status)) {
    return (
      <div className="flex flex-col gap-3" aria-live="polite">
        <p className="text-lg font-semibold">
          {STAGE[project.status]} {project.status !== "queued" && `· ${project.progress}%`}
        </p>
        <ProgressBar value={project.progress} />
        <p className="text-ink-soft">
          This takes about as long as the video itself. You can close this page — it keeps going.
        </p>
      </div>
    );
  }

  if (project.status === "done" && project.youtubeVideoId) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-2xl bg-leaf-soft px-4 py-3 text-lg">
          It's on YouTube as <b>private</b>. Check it, then publish it from YouTube Studio.
        </p>
        {project.errorMessage && <ErrorNote>{project.errorMessage}</ErrorNote>}
        <a
          href={`https://studio.youtube.com/video/${project.youtubeVideoId}/edit`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-16 items-center justify-center rounded-2xl bg-violet px-6 text-lg font-semibold text-white"
        >
          Open in YouTube Studio
        </a>
        <Button tone="quiet" onClick={send} disabled={sending || problems.length > 0}>
          Made changes? Send it again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {project.status === "failed" && project.errorMessage && <ErrorNote>{project.errorMessage}</ErrorNote>}
      {problems.length > 0 ? (
        <div>
          <p className="mb-2 font-semibold">Before sending:</p>
          <ul className="flex flex-col gap-2">
            {problems.map((p) => (
              <li key={p} className="flex gap-2">
                <span aria-hidden className="text-eosin">
                  ●
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-ink-soft">
          We'll add your intro, apply your edits, clean up the sound, and upload it as private.
        </p>
      )}
      <Button big onClick={send} disabled={sending || problems.length > 0}>
        {sending ? "Starting…" : project.status === "failed" ? "Try again" : "Send to YouTube"}
      </Button>
    </div>
  );
}
