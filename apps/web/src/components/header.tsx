"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import type { Me } from "@/lib/types";

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (pathname.startsWith("/login")) return;
    api<Me>("/me").then(setMe).catch(() => {});
  }, [pathname]);

  if (pathname.startsWith("/login")) return null;

  return (
    <header className="mx-auto flex w-full max-w-xl items-center justify-between px-4 pt-4 pb-2">
      <Link href="/projects" className="font-display text-xl font-bold text-ink">
        Biology Studio
      </Link>
      <nav className="flex items-center gap-4 text-ink-soft">
        {me?.role === "admin" && (
          <Link href="/settings" className="py-2">
            Settings
          </Link>
        )}
        {me && (
          <button
            type="button"
            className="py-2"
            onClick={async () => {
              await authClient.signOut();
              router.push("/login");
            }}
          >
            Sign out
          </button>
        )}
      </nav>
    </header>
  );
}
