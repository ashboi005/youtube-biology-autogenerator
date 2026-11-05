import type { ProjectStatus } from "@/lib/types";

const LABEL: Record<ProjectStatus, [string, string]> = {
  draft: ["Draft", "bg-slide text-ink-soft"],
  queued: ["Waiting", "bg-amber-soft text-amber"],
  rendering: ["Making video", "bg-violet-soft text-violet"],
  uploading: ["Sending", "bg-violet-soft text-violet"],
  done: ["On YouTube", "bg-leaf-soft text-leaf"],
  failed: ["Needs a retry", "bg-eosin-soft text-eosin"],
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const [label, cls] = LABEL[status];
  return <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${cls}`}>{label}</span>;
}
