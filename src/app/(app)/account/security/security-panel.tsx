"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ShieldCheck, ShieldOff, Copy, Download, RefreshCw } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";
import { recordTwoFactorEventAction, revokeMyTrustedDevicesAction } from "@/actions/account";

type Stage = { step: "idle" } | { step: "password"; purpose: "enable" | "disable" | "codes" } | { step: "scan"; uri: string; secret: string; backupCodes: string[] } | { step: "codes"; backupCodes: string[]; title: string };

function errorText(code: string | undefined, fallback: string, status?: number) {
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (code === "INVALID_PASSWORD") return "Password not recognised.";
  if (code === "INVALID_CODE") return "That code is not valid. Check the time on your phone and try the current code.";
  if (code === "ACCOUNT_TEMPORARILY_LOCKED") return "Too many wrong codes. Try again in 15 minutes.";
  return fallback;
}

function secretFromUri(uri: string) {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function SecurityPanel({ enabled, hasPassword, required, email }: { enabled: boolean; hasPassword: boolean; required: boolean; email: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ step: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!hasPassword) {
    return (
      <Card title="Two-factor authentication">
        <p className="text-sm text-slate-600">Your account signs in with Microsoft 365 only, so your second factor is managed by Microsoft (Entra ID multi-factor authentication). Nothing to set up here.</p>
      </Card>
    );
  }

  const beginPassword = (purpose: "enable" | "disable" | "codes") => {
    setPassword("");
    setCode("");
    setError(null);
    setNotice(null);
    setStage({ step: "password", purpose });
  };

  const submitPassword = async () => {
    if (stage.step !== "password") return;
    setBusy(true);
    setError(null);
    try {
      if (stage.purpose === "enable") {
        const res = await authClient.twoFactor.enable({ password });
        if (res.error || !res.data || !("totpURI" in res.data)) {
          setError(errorText(res.error?.code, "Could not start enrolment.", res.error?.status));
          return;
        }
        setStage({ step: "scan", uri: res.data.totpURI, secret: secretFromUri(res.data.totpURI), backupCodes: res.data.backupCodes });
      } else if (stage.purpose === "disable") {
        const res = await authClient.twoFactor.disable({ password });
        if (res.error) {
          setError(errorText(res.error.code, "Could not turn off two-factor authentication.", res.error.status));
          return;
        }
        await recordTwoFactorEventAction("disabled");
        setStage({ step: "idle" });
        setNotice("Two-factor authentication is off. Your other sessions have been signed out.");
        router.refresh();
      } else {
        const res = await authClient.twoFactor.generateBackupCodes({ password });
        if (res.error || !res.data) {
          setError(errorText(res.error?.code, "Could not generate new recovery codes.", res.error?.status));
          return;
        }
        await recordTwoFactorEventAction("backup_codes_regenerated");
        setStage({ step: "codes", backupCodes: res.data.backupCodes, title: "Your new recovery codes" });
      }
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  const submitCode = async () => {
    if (stage.step !== "scan") return;
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") });
    setBusy(false);
    if (res.error) {
      setError(errorText(res.error.code, "That code is not valid.", res.error.status));
      return;
    }
    await recordTwoFactorEventAction("enabled");
    setStage({ step: "codes", backupCodes: stage.backupCodes, title: "Save your recovery codes" });
  };

  return (
    <div className="space-y-4">
      {notice && <Alert tone="info">{notice}</Alert>}
      <Card
        title="Two-factor authentication"
        actions={enabled ? <Badge tone="green">on</Badge> : <Badge tone={required ? "amber" : "slate"}>{required ? "required" : "off"}</Badge>}
      >
        {stage.step === "idle" && (
          <div className="space-y-3 text-sm text-slate-600">
            {enabled ? (
              <>
                <p className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden />
                  <span>
                    Signing in as <strong>{email}</strong> asks for a code from your authenticator app, unless you have trusted the browser within the last 30 days.
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => beginPassword("codes")}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> New recovery codes
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await revokeMyTrustedDevicesAction();
                        setNotice(r.ok ? (r.data.count ? `Forgot ${r.data.count} trusted browser${r.data.count === 1 ? "" : "s"}. You will be asked for a code next time you sign in.` : "No trusted browsers to forget.") : r.error);
                      })
                    }
                  >
                    Forget trusted browsers
                  </Button>
                  <Button size="sm" variant="danger-outline" onClick={() => beginPassword("disable")}>
                    <ShieldOff className="h-3.5 w-3.5" aria-hidden /> Turn off
                  </Button>
                </div>
                {required && <p className="text-xs text-amber-700">Your role requires two-factor authentication. If you turn it off you will be asked to set it up again.</p>}
              </>
            ) : (
              <>
                <p>Add a second step to your sign-in: a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, Bitwarden and similar). You will also get recovery codes for when your phone is unavailable.</p>
                <Button size="sm" onClick={() => beginPassword("enable")}>
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Set up authenticator app
                </Button>
              </>
            )}
          </div>
        )}

        {stage.step === "password" && (
          <form
            className="max-w-sm space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPassword();
            }}
          >
            {error && <Alert tone="error">{error}</Alert>}
            <Field label="Confirm your CRM password" htmlFor="tf-password" help={stage.purpose === "disable" ? "Turning it off signs out your other sessions." : stage.purpose === "codes" ? "Your old recovery codes stop working." : undefined}>
              <Input id="tf-password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={busy} variant={stage.purpose === "disable" ? "danger" : "primary"}>
                {stage.purpose === "enable" ? "Continue" : stage.purpose === "disable" ? "Turn off" : "Generate codes"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setStage({ step: "idle" })}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {stage.step === "scan" && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode();
            }}
          >
            {error && <Alert tone="error">{error}</Alert>}
            <ol className="list-decimal space-y-3 pl-5 text-sm text-slate-700">
              <li>
                Scan this QR code with your authenticator app, or type the key by hand.
                <div className="mt-2 flex flex-wrap items-start gap-4">
                  <QrImage uri={stage.uri} />
                  <div className="min-w-0 text-xs text-slate-600">
                    <div className="mb-1 font-medium text-slate-700">Manual key</div>
                    <code className="block break-all rounded bg-slate-100 px-2 py-1 font-mono text-[13px] tracking-wider text-slate-800" data-testid="totp-secret">
                      {stage.secret.replace(/(.{4})/g, "$1 ").trim()}
                    </code>
                    <div className="mt-1">Time-based, 6 digits, 30 seconds.</div>
                  </div>
                </div>
              </li>
              <li>
                Enter the code the app shows now.
                <div className="mt-2 max-w-[200px]">
                  <Input id="tf-code" aria-label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className="text-center text-lg tracking-widest" />
                </div>
              </li>
            </ol>
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={busy}>
                Verify and turn on
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setStage({ step: "idle" })}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {stage.step === "codes" && <RecoveryCodes codes={stage.backupCodes} title={stage.title} email={email} onDone={() => { setStage({ step: "idle" }); router.refresh(); }} />}
      </Card>
    </div>
  );
}

function QrImage({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(uri, { width: 176, margin: 1 }).then(setSrc).catch(() => setSrc(null));
  }, [uri]);
  if (!src) return <div className="h-44 w-44 rounded border border-slate-200 bg-slate-50" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="QR code for your authenticator app" width={176} height={176} className="rounded border border-slate-200" />;
}

function RecoveryCodes({ codes, title, email, onDone }: { codes: string[]; title: string; email: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Recovery codes for ${email}\nEach code can be used once instead of an authenticator code.\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-3">
      <Alert tone="warn" title={title}>
        These codes are shown once. Keep them somewhere safe, such as your password manager. Each one signs you in once if you lose your phone.
      </Alert>
      <ul className="grid grid-cols-2 gap-1 rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-sm sm:grid-cols-3" data-testid="backup-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(codes.join("\n"));
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const blob = new Blob([text], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "crm-recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download className="h-3.5 w-3.5" aria-hidden /> Download
        </Button>
        <Button size="sm" onClick={onDone}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}
