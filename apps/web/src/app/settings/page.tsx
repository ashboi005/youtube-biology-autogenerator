"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button, Panel, ProgressBar, Spinner } from "@/components/ui";
import { api, putWithProgress } from "@/lib/api";

type Settings = {
  fadeSeconds: number;
  audioCleanup: boolean;
  thumbnailPromptTemplate: string;
  introUrl: string | null;
  outroUrl: string | null;
  youtube: { channelTitle: string; connectedAt: string } | null;
};

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [template, setTemplate] = useState("");

  const load = async () => {
    try {
      const r = await api<Settings>("/settings");
      setS(r);
      setTemplate(r.thumbnailPromptTemplate);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const q = new URLSearchParams(location.search).get("youtube");
    if (q === "connected") toast.success("YouTube connected");
    if (q === "error") toast.error("YouTube connection didn't finish — try again");
  }, []);

  const patch = async (body: Partial<Settings>) => {
    try {
      await api("/settings", { method: "PATCH", body });
      toast.success("Saved");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!s) return <Spinner />;

  return (
    <div className="flex flex-col gap-4 pt-2">
      <h1 className="font-display text-3xl font-bold">Settings</h1>

      <Panel>
        <h2 className="mb-2 text-xl font-bold">YouTube</h2>
        {s.youtube ? (
          <div className="flex flex-col gap-3">
            <p>
              Connected to <b>{s.youtube.channelTitle}</b>.
            </p>
            <Button
              tone="plain"
              onClick={async () => {
                if (!window.confirm("Disconnect YouTube? Uploads will stop until you reconnect.")) return;
                await api("/youtube", { method: "DELETE" });
                await load();
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-ink-soft">
              Sign in with the Google account that owns the channel. Google will warn that the app is unverified —
              that's expected for a private app. Custom thumbnails need a phone-verified channel.
            </p>
            <Button
              onClick={async () => {
                const { url } = await api<{ url: string }>("/youtube/connect");
                location.href = url;
              }}
            >
              Connect YouTube
            </Button>
          </div>
        )}
      </Panel>

      <Bumper kind="intro" url={s.introUrl} onChange={load} />
      <Bumper kind="outro" url={s.outroUrl} onChange={load} />

      <Panel>
        <h2 className="mb-3 text-xl font-bold">Video</h2>
        <label className="flex flex-col gap-2">
          <span>Intro fade length: {s.fadeSeconds.toFixed(1)}s</span>
          <input
            type="range"
            min={0.2}
            max={3}
            step={0.1}
            defaultValue={s.fadeSeconds}
            onPointerUp={(e) => patch({ fadeSeconds: Number((e.target as HTMLInputElement).value) })}
            onKeyUp={(e) => patch({ fadeSeconds: Number((e.target as HTMLInputElement).value) })}
          />
        </label>
        <label className="mt-4 flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={s.audioCleanup}
            onChange={(e) => patch({ audioCleanup: e.target.checked })}
          />
          Clean up sound (gentle noise reduction and even volume)
        </label>
      </Panel>

      <Panel>
        <h2 className="mb-2 text-xl font-bold">Thumbnail prompt template</h2>
        <p className="mb-3 text-ink-soft">
          Instructions the AI follows when writing a thumbnail prompt. The video's title and description are added
          automatically.
        </p>
        <textarea
          className="min-h-64 w-full rounded-2xl border-2 border-line p-4 font-mono text-sm"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <Button className="mt-3 w-full" onClick={() => patch({ thumbnailPromptTemplate: template })}>
          Save template
        </Button>
      </Panel>
    </div>
  );
}

function Bumper({ kind, url, onChange }: { kind: "intro" | "outro"; url: string | null; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const label = kind === "intro" ? "Intro" : "Outro";

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setProgress(0);
    try {
      const { uploadUrl } = await api<{ uploadUrl: string }>("/settings/bumper", { body: { kind } });
      await putWithProgress(uploadUrl, file, "video/mp4", (l) => setProgress((l / file.size) * 100));
      await api("/settings/bumper/complete", { body: { kind } });
      toast.success(`${label} saved`);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Panel>
      <h2 className="mb-2 text-xl font-bold">{label}</h2>
      <p className="mb-3 text-ink-soft">
        {kind === "intro"
          ? "Plays at the start of every video, then fades into the lesson."
          : "Optional. Fades in at the end of every video."}
      </p>
      {url && <video src={url} controls playsInline className="mb-3 aspect-video w-full rounded-2xl bg-ink" />}
      {progress !== null && <ProgressBar value={progress} />}
      <input ref={input} type="file" accept="video/*" hidden onChange={(e) => void upload(e.target.files?.[0])} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button tone={url ? "plain" : "violet"} onClick={() => input.current?.click()} disabled={progress !== null}>
          {url ? `Replace ${kind}` : `Upload ${kind}`}
        </Button>
        {url && (
          <Button
            tone="plain"
            onClick={async () => {
              await api(`/settings/bumper/${kind}`, { method: "DELETE" });
              onChange();
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </Panel>
  );
}
