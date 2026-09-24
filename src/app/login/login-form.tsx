"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";

export function LoginForm({ next, microsoft, initialError }: { next: string; microsoft: boolean; initialError?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [loading, setLoading] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        const res = await signIn.email({ email, password });
        setLoading(false);
        if (res.error) {
          setError(res.error.message ?? "Sign-in failed. Check your email and password.");
          return;
        }
        if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
          router.push(`/login/verify?next=${encodeURIComponent(next)}`);
          return;
        }
        router.push(next);
        router.refresh();
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Email" htmlFor="email">
        <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" className="w-full" loading={loading}>
        Sign in
      </Button>
      {microsoft && (
        <>
          <div className="relative text-center text-xs text-slate-400">
            <span className="bg-surface px-2">or</span>
            <div className="absolute inset-x-0 top-1/2 -z-10 border-t border-slate-200" />
          </div>
          <Button type="button" variant="secondary" className="w-full" onClick={() => signIn.social({ provider: "microsoft", callbackURL: next })}>
            Sign in with Microsoft 365
          </Button>
        </>
      )}
    </form>
  );
}
