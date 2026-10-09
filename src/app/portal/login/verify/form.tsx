"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";
import { portalVerifyCodeAction } from "@/actions/portal";

export function VerifyForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        const r = await portalVerifyCodeAction(code);
        setBusy(false);
        if (!r.ok) return setError(r.error);
        if ("setupRequired" in r.data) return router.replace("/portal/login/setup");
        if (r.data.factor === "recovery" && r.data.recoveryCodesLeft <= 2) {
          router.push(`/portal?notice=${encodeURIComponent(`You have ${r.data.recoveryCodesLeft} recovery code${r.data.recoveryCodesLeft === 1 ? "" : "s"} left. Ask your IT provider to reset your authenticator if you no longer have your phone.`)}`);
        } else router.push("/portal");
        router.refresh();
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Authenticator or recovery code" htmlFor="pv-code">
        <Input id="pv-code" inputMode="text" autoComplete="one-time-code" maxLength={20} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className="text-center text-lg tracking-widest" />
      </Field>
      <Button type="submit" className="w-full" loading={busy}><ShieldCheck className="h-4 w-4" /> Continue</Button>
      <p className="text-center text-xs text-slate-500">Lost your phone and your recovery codes? Contact your IT provider; they can reset your authenticator.</p>
    </form>
  );
}
