"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Project } from "@/lib/types";

type Props = { project: Project; refresh: () => Promise<void>; locked: boolean };

export function DetailsStep({ project, refresh, locked }: Props) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Partial<Pick<Project, "title" | "description" | "privacy">>>({});

  const save = (patch: Partial<Pick<Project, "title" | "description" | "privacy">>) => {
    clearTimeout(timer.current);
    pending.current = { ...pending.current, ...patch };
    setSaved("saving");
    timer.current = setTimeout(async () => {
      const body = pending.current;
      pending.current = {};
      try {
        await api(`/projects/${project.id}`, { method: "PATCH", body });
        setSaved("saved");
        await refresh();
      } catch (e) {
        setSaved("idle");
        toast.error((e as Error).message);
      }
    }, 700);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  const field = "w-full rounded-2xl border-2 border-line bg-surface px-4 py-3 text-lg disabled:opacity-60";

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-2">
        <span className="flex justify-between font-semibold">
          Title <span className="font-normal text-ink-soft">{title.length}/100</span>
        </span>
        <input
          className={field}
          maxLength={100}
          value={title}
          disabled={locked}
          placeholder="e.g. Mitosis explained in 5 minutes"
          onChange={(e) => {
            setTitle(e.target.value);
            save({ title: e.target.value });
          }}
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="flex justify-between font-semibold">
          Description <span className="font-normal text-ink-soft">{description.length}/5000</span>
        </span>
        <textarea
          className={`${field} min-h-48`}
          maxLength={5000}
          value={description}
          disabled={locked}
          placeholder="What does this video teach?"
          onChange={(e) => {
            setDescription(e.target.value);
            save({ description: e.target.value });
          }}
        />
      </label>
      <fieldset className="flex flex-col gap-2" disabled={locked}>
        <legend className="mb-2 font-semibold">Who can see it on YouTube</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["private", "unlisted"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={project.privacy === p}
              onClick={() => save({ privacy: p })}
              className={`min-h-14 rounded-2xl border-2 font-semibold ${
                project.privacy === p ? "border-violet bg-violet-soft text-violet" : "border-line bg-surface"
              }`}
            >
              {p === "private" ? "Only me" : "Anyone with the link"}
            </button>
          ))}
        </div>
        <p className="text-sm text-ink-soft">
          It always arrives on YouTube as private. Open YouTube Studio to publish it when you're happy.
        </p>
      </fieldset>
      <p className="text-sm text-ink-soft" aria-live="polite">
        {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : ""}
      </p>
    </div>
  );
}
