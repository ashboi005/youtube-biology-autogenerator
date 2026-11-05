"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, ErrorNote } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex min-h-svh flex-col justify-center gap-8 py-10">
      <div>
        <h1 className="font-display text-4xl font-bold">Biology Studio</h1>
        <p className="mt-2 text-ink-soft">Sign in to make a video.</p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const { error } = await authClient.signIn.email({ email, password });
          setBusy(false);
          if (error) setError(error.message ?? "Email or password is wrong");
          else router.push("/projects");
        }}
      >
        <label className="flex flex-col gap-2">
          <span className="font-semibold">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-14 rounded-2xl border-2 border-line bg-surface px-4 text-lg"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="font-semibold">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-14 rounded-2xl border-2 border-line bg-surface px-4 text-lg"
          />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button big type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
