"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { ClipsStep } from "@/components/steps/clips-step";
import { DetailsStep } from "@/components/steps/details-step";
import { EditStep } from "@/components/steps/edit-step";
import { SendStep } from "@/components/steps/send-step";
import { ThumbnailStep } from "@/components/steps/thumbnail-step";
import { Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { isBusy, type ProjectDetail } from "@/lib/types";

type StepId = "clips" | "edit" | "details" | "thumbnail" | "send";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [open, setOpen] = useState<StepId | null>("clips");

  const refresh = useCallback(async () => {
    try {
      setDetail(await api<ProjectDetail>(`/projects/${id}`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while the server is working on it.
  const busy = detail ? isBusy(detail.project.status) : false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [busy, refresh]);

  // Jump straight to the send step when revisiting a processed video.
  useEffect(() => {
    if (detail && detail.project.status !== "draft") setOpen((o) => (o === "clips" ? "send" : o));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.project.id]);

  if (!detail) return <Spinner />;
  const { project, clips } = detail;
  const readyClips = clips.filter((c) => c.uploadState === "ready");

  const steps: { id: StepId; title: string; summary: string; done: boolean; body: ReactNode }[] = [
    {
      id: "clips",
      title: "Clips",
      summary: clips.length ? `${clips.length} clip${clips.length > 1 ? "s" : ""}` : "Add the videos you filmed",
      done: readyClips.length > 0 && readyClips.length === clips.length,
      body: <ClipsStep detail={detail} refresh={refresh} locked={busy} />,
    },
    {
      id: "edit",
      title: "Edit",
      summary: (() => {
        const n = clips.reduce((s, c) => s + c.cuts.length + c.overlays.length + c.voiceovers.length, 0);
        return n ? `${n} change${n > 1 ? "s" : ""}` : "Cut mistakes, add text, re-record";
      })(),
      done: false,
      body: <EditStep detail={detail} refresh={refresh} locked={busy} />,
    },
    {
      id: "details",
      title: "Title and description",
      summary: project.title || "What's this video called?",
      done: Boolean(project.title.trim() && project.description.trim()),
      body: <DetailsStep project={project} refresh={refresh} locked={busy} />,
    },
    {
      id: "thumbnail",
      title: "Thumbnail",
      summary: project.thumbnailKey ? "Thumbnail added" : "Make one with ChatGPT",
      done: Boolean(project.thumbnailKey),
      body: <ThumbnailStep project={project} refresh={refresh} locked={busy} />,
    },
    {
      id: "send",
      title: "Send to YouTube",
      summary: project.status === "done" ? "On YouTube (private)" : "Upload when everything's ready",
      done: project.status === "done",
      body: <SendStep detail={detail} refresh={refresh} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="truncate font-display text-3xl font-bold">{project.title || "New video"}</h1>
        <StatusBadge status={project.status} />
      </div>

      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const isOpen = open === s.id;
          return (
            <li key={s.id} className="overflow-hidden rounded-3xl border border-line bg-surface">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : s.id)}
                className="flex w-full items-center gap-4 px-5 py-4 text-left"
              >
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-full font-display text-lg font-bold ${
                    s.done ? "bg-leaf text-white" : isOpen ? "bg-violet text-white" : "bg-slide text-ink-soft"
                  }`}
                  aria-hidden
                >
                  {s.done ? "✓" : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-lg font-semibold">{s.title}</span>
                  <span className="block truncate text-ink-soft">{s.summary}</span>
                </span>
              </button>
              {isOpen && <div className="border-t border-line px-5 py-5">{s.body}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
