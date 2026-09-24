"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input, Checkbox } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";

/**
 * Second step of sign-in. The pending sign-in is identified by a short-lived
 * signed cookie the server set when the password was accepted; no session
 * exists until a code is verified.
 */
export function VerifyForm({ next }: { next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        const clean = recovery ? code.trim() : code.replace(/\s+/g, "");
        const res = recovery ? await authClient.twoFactor.verifyBackupCode({ code: clean, trustDevice: trust }) : await authClient.twoFactor.verifyTotp({ code: clean, trustDevice: trust });
        setLoading(false);
        if (res.error) {
          const c = res.error.code ?? "";
          if (res.error.status === 429) setError("Too many attempts. Wait a minute and try again.");
          else if (c === "INVALID_TWO_FACTOR_COOKIE") setError("Your sign-in has expired. Go back and sign in again.");
          else if (c === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") setError("Too many wrong codes for this sign-in. Go back and sign in again.");
          else if (c === "ACCOUNT_TEMPORARILY_LOCKED") setError("Too many wrong codes. Your second factor is locked for 15 minutes.");
          else setError(recovery ? "That recovery code is not valid. Each code works once." : "That code is not valid. Check the time on your phone and try the current code.");
          return;
        }
        router.push(next);
        router.refresh();
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={recovery ? "Recovery code" : "Authenticator code"} htmlFor="code" help={recovery ? "One of the codes you saved when you set up two-factor authentication." : undefined}>
        <Input id="code" inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" pattern={recovery ? undefined : "[0-9 ]{6,7}"} maxLength={recovery ? 12 : 7} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder={recovery ? "abcde-12345" : "123 456"} className="text-center text-lg tracking-widest" />
      </Field>
      <Checkbox label="Trust this browser for 30 days" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
      <Button type="submit" className="w-full" loading={loading}>
        Verify
      </Button>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <button type="button" className="hover:text-slate-800 hover:underline" onClick={() => { setRecovery((r) => !r); setCode(""); setError(null); }}>
          {recovery ? "Use my authenticator app" : "Use a recovery code"}
        </button>
        <Link href="/login" className="hover:text-slate-800 hover:underline">
          Back to sign in
        </Link>
      </div>
    </form>
  );
}
