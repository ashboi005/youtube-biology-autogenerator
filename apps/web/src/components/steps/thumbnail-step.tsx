"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, ErrorNote } from "@/components/ui";
import { api, putWithProgress } from "@/lib/api";
import { toThumbnail } from "@/lib/image";
import type { Project } from "@/lib/types";

type Props = { project: Project; refresh: () => Promise<void>; locked: boolean };

export function ThumbnailStep({ project, refresh, locked }: Props) {
  const [prompt, setPrompt] = useState(project.thumbnailPrompt ?? "");
  const [thinking, setThinking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ready = Boolean(project.title.trim() && project.description.trim());

  useEffect(() => {
    if (!project.thumbnailKey) return;
    api<{ url: string | null }>(`/projects/${project.id}/thumbnail-url`)
      .then((r) => setPreview(r.url))
      .catch(() => {});
  }, [project.id, project.thumbnailKey]);

  const makePrompt = async () => {
    setThinking(true);
    try {
      const r = await api<{ prompt: string }>(`/projects/${project.id}/thumbnail-prompt`, { body: {} });
      setPrompt(r.prompt);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setThinking(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("Copied — now paste it into ChatGPT");
    } catch {
      toast.error("Couldn't copy. Press and hold the text to copy it.");
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const blob = await toThumbnail(file);
      const { uploadUrl } = await api<{ uploadUrl: string }>(`/projects/${project.id}/thumbnail`, { body: {} });
      await putWithProgress(uploadUrl, blob, "image/jpeg");
      const r = await api<{ url: string }>(`/projects/${project.id}/thumbnail/complete`, { body: {} });
      setPreview(r.url);
      toast.success("Thumbnail added");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="Current thumbnail" className="aspect-video w-full rounded-2xl object-cover" />
      )}

      {!ready ? (
        <ErrorNote>Fill in the title and description first — the AI uses them to write the prompt.</ErrorNote>
      ) : (
        <>
          <Button big onClick={makePrompt} disabled={thinking || locked}>
            {thinking ? "Writing a prompt…" : prompt ? "Write a new prompt" : "Make thumbnail prompt"}
          </Button>
          {prompt && (
            <div className="flex flex-col gap-3">
              <p className="select-all rounded-2xl bg-slide p-4 whitespace-pre-wrap">{prompt}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={copy}>Copy prompt</Button>
                <a
                  href="https://chatgpt.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-12 items-center justify-center rounded-2xl border-2 border-line font-semibold"
                >
                  Open ChatGPT
                </a>
              </div>
              <p className="text-sm text-ink-soft">
                Paste the prompt into ChatGPT, save the picture it makes to your Photos, then upload it here.
              </p>
            </div>
          )}
        </>
      )}

      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      <Button tone="plain" big onClick={() => input.current?.click()} disabled={uploading || locked}>
        {uploading ? "Uploading…" : preview ? "Change thumbnail" : "Upload thumbnail"}
      </Button>
    </div>
  );
}
