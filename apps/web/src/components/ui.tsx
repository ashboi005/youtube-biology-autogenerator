"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Tone = "violet" | "eosin" | "plain" | "quiet";

const TONES: Record<Tone, string> = {
  violet: "bg-violet text-white active:brightness-90",
  eosin: "bg-eosin text-white active:brightness-90",
  plain: "bg-surface text-ink border-2 border-line active:bg-slide",
  quiet: "bg-transparent text-violet underline-offset-4 hover:underline",
};

export function Button({
  tone = "violet",
  big,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; big?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition disabled:opacity-40 ${
        big ? "min-h-16 px-6 text-lg" : "min-h-12 px-4 text-base"
      } ${TONES[tone]} ${className}`}
    />
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-3xl border border-line bg-surface p-5 ${className}`}>{children}</section>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 p-6 text-ink-soft" role="status">
      <span className="size-5 animate-spin rounded-full border-2 border-line border-t-violet" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ProgressBar({ value, tone = "violet" }: { value: number; tone?: "violet" | "leaf" }) {
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-slide" role="progressbar" aria-valuenow={Math.round(value)}>
      <div
        className={`h-full rounded-full ${tone === "leaf" ? "bg-leaf" : "bg-violet"} transition-[width]`}
        style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl bg-eosin-soft px-4 py-3 text-ink">{children}</p>;
}
