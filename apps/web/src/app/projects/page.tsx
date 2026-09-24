"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Button, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<Project[]>("/projects").then(setProjects).catch((e) => toast.error(e.message));
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const p = await api<Project>("/projects", { body: {} });
      router.push(`/projects/${p.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 pt-4">
      <Button big onClick={create} disabled={creating}>
        {creating ? "Starting…" : "New video"}
      </Button>

      {!projects ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <p className="text-ink-soft">Your videos will show up here. Tap “New video” to start the first one.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="flex items-center justify-between gap-3 rounded-3xl border border-line bg-surface px-5 py-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">{p.title || "Untitled video"}</p>
                  <p className="text-sm text-ink-soft">
                    {new Date(p.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  </p>
                </div>
                <StatusBadge status={p.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
