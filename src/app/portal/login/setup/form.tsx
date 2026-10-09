"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";
import { portalTotpSetupBeginAction, portalTotpSetupConfirmAction } from "@/actions/portal";

export function SetupForm({ email, alreadyEnrolled }: { email: string; alreadyEnrolled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (alreadyEnrolled) {
      router.replace("/portal/login/verify");
      return;
    }
    portalTotpSetupBeginAction().then((r) => (r.ok ? setSetup(r.data) : setError(r.error)));
  }, [alreadyEnrolled, router]);
  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.uri, { width: 176, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [setup]);

  if (codes) {
    const text = `Recovery codes for the support portal (${email})\nEach code signs you in once if your phone is unavailable.\n\n${codes.join("\n")}\n`;
    return (
      <div className="space-y-3">
        <Alert tone="success" title="Authenticator set up">Save these recovery codes somewhere safe. Each works once if your phone is lost. You will not see them again.</Alert>
        <ul className="grid grid-cols-2 gap-1 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-sm">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(text).catch(() => undefined)}><Copy className="h-4 w-4" /> Copy</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = "support-portal-recovery-codes.txt"; a.click(); }}><Download className="h-4 w-4" /> Download</Button>
          <Button type="button" size="sm" onClick={() => { router.push("/portal"); router.refresh(); }}>I have saved them, continue</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        const r = await portalTotpSetupConfirmAction(code);
        setBusy(false);
        if (!r.ok) return setError(r.error);
        setCodes(r.data.recoveryCodes);
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <ol className="list-decimal space-y-3 pl-5 text-sm text-slate-700">
        <li>
          Open your authenticator app, add an account, and scan this code (or type the key).
          <div className="mt-2 flex flex-wrap items-start gap-4">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="QR code for your authenticator app" width={176} height={176} className="rounded border border-slate-200" />
            ) : (
              <div className="h-44 w-44 rounded border border-slate-200 bg-slate-50" aria-hidden />
            )}
            <div className="min-w-0 text-xs text-slate-600">
              <div className="mb-1 font-medium text-slate-700">Manual key</div>
              <code className="block break-all rounded bg-slate-100 px-2 py-1 font-mono text-[13px] tracking-wider text-slate-800">{setup ? setup.secret.replace(/(.{4})/g, "$1 ").trim() : "…"}</code>
              <div className="mt-1">Time-based, 6 digits, 30 seconds.</div>
            </div>
          </div>
        </li>
        <li>
          Enter the 6-digit code the app shows now.
          <div className="mt-2 max-w-[200px]">
            <Input aria-label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className="text-center text-lg tracking-widest" />
          </div>
        </li>
      </ol>
      <Button type="submit" loading={busy} disabled={!setup}><ShieldCheck className="h-4 w-4" /> Verify and continue</Button>
    </form>
  );
}
