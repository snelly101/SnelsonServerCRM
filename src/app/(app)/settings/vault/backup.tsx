"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea, Checkbox } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { StepUpDialog } from "@/components/vault/step-up-dialog";
import { useToast } from "@/components/ui/toast";

export type BackupStatus = { usedThisHour: number; limitPerHour: number; allowed: boolean; last: { at: string; actorName: string | null; items: number; encrypted: boolean; sha256: string } | null };

const EXPORT_ACK = "EXPORT ALL SECRETS";
const IMPORT_ACK = "IMPORT BACKUP";

type ExportSummary = { items: number; archived: number; companies: number; failed: number; sha256: string; encrypted: boolean; notified: number; filename: string };
type ImportSummary = { created: number; skipped: number; companiesCreated: number; categoriesCreated: number; errors: { item: string; error: string }[]; sha256: string };

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function VaultBackupControls({ status, windowMinutes, admins }: { status: BackupStatus; windowMinutes: number; admins: number }) {
  const router = useRouter();
  const toast = useToast();
  const [stepUpFor, setStepUpFor] = useState<"export" | "import" | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportResult, setExportResult] = useState<ExportSummary | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={!status.allowed} onClick={() => setStepUpFor("export")}>
          <Download className="h-4 w-4" /> Export backup
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setStepUpFor("import")}>
          <Upload className="h-4 w-4" /> Import backup
        </Button>
        <span className="text-xs text-slate-500">
          {status.usedThisHour}/{status.limitPerHour} exports used this hour
          {status.last ? ` · last ${new Date(status.last.at).toLocaleString("en-GB")} by ${status.last.actorName ?? "unknown"} (${status.last.items} items, ${status.last.encrypted ? "passphrase-protected" : "plain file"})` : " · never exported"}
        </span>
      </div>
      {exportResult && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          <p className="font-medium">Downloaded {exportResult.filename}: {exportResult.items} items ({exportResult.archived} archived) across {exportResult.companies} customers{exportResult.failed ? `, ${exportResult.failed} could not be decrypted` : ""}. {exportResult.notified} administrator{exportResult.notified === 1 ? "" : "s"} notified.</p>
          <p className="mt-1 break-all font-mono">SHA-256 {exportResult.sha256}</p>
          <p className="mt-1">{exportResult.encrypted ? "Decrypt with: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in FILE.zip.enc -out FILE.zip" : "This file is clear text. Move it to offline storage now and delete it from Downloads."}</p>
        </div>
      )}
      {importResult && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" role="status">
          <p className="font-medium">Import finished: {importResult.created} created, {importResult.skipped} already present, {importResult.errors.length} failed{importResult.companiesCreated ? `, ${importResult.companiesCreated} customers created` : ""}{importResult.categoriesCreated ? `, ${importResult.categoriesCreated} categories created` : ""}.</p>
          {importResult.errors.slice(0, 10).map((e, i) => (
            <p key={i} className="mt-1 text-red-700">{e.item}: {e.error}</p>
          ))}
        </div>
      )}

      <StepUpDialog
        open={stepUpFor !== null}
        onOpenChange={(o) => { if (!o) setStepUpFor(null); }}
        windowMinutes={windowMinutes}
        onVerified={() => {
          if (stepUpFor === "export") setExportOpen(true);
          if (stepUpFor === "import") setImportOpen(true);
          setStepUpFor(null);
        }}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        admins={admins}
        onDone={(r) => {
          setExportResult(r);
          toast(`Backup downloaded: ${r.items} items.`, "success");
          router.refresh();
        }}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onDone={(r) => {
          setImportResult(r);
          toast(`Imported ${r.created} item${r.created === 1 ? "" : "s"}.`, "success");
          router.refresh();
        }}
      />
    </div>
  );
}

function ExportDialog({ open, onOpenChange, onDone, admins }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (r: ExportSummary) => void; admins: number }) {
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState("");
  const [protect, setProtect] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [plainOk, setPlainOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setReason(""); setAck(""); setPassphrase(""); setConfirm(""); setPlainOk(false); setError(null); setProtect(true); };
  const ready = reason.trim().length >= 5 && ack.trim().toUpperCase() === EXPORT_ACK && (protect ? passphrase.length >= 12 && passphrase === confirm : plainOk);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("reason", reason);
      fd.set("acknowledgement", ack);
      if (protect) fd.set("passphrase", passphrase);
      const res = await fetch("/api/vault/export", { method: "POST", body: fd });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Export failed (${res.status}).`);
        return;
      }
      const summary = JSON.parse(res.headers.get("X-Vault-Export") ?? "{}") as ExportSummary;
      const blob = await res.blob();
      saveBlob(blob, summary.filename || "vault-backup.zip");
      onOpenChange(false);
      reset();
      onDone(summary);
    } catch {
      setError("The download did not complete. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent title="Export the whole vault in clear text" description="Every credential, archived ones included, is decrypted into one ZIP (CSV, JSON, README). For disaster recovery and migration only." wide>
        <form className="space-y-3" onSubmit={submit}>
          <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              This is recorded permanently in the vault audit trail with your name, IP address, the reason and the file&apos;s hash, and {admins > 1 ? `the other ${admins - 1} administrator${admins === 2 ? "" : "s"} get` : "you get"} an urgent task to confirm it was expected. Store the file offline (password manager attachment or sealed envelope), never in email, chat or a shared drive.
            </div>
          </div>
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
          <Field label="Reason" htmlFor="ex-reason" help="Recorded in the audit trail, e.g. quarterly offline backup, migrating to another tool">
            <Textarea id="ex-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
          </Field>
          <Checkbox label="Protect the download with a passphrase (recommended; the file is unreadable without it)" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
          {protect ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Passphrase (12+ characters)" htmlFor="ex-pass" help="Store it separately from the file; it is not kept anywhere in the CRM">
                <Input id="ex-pass" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} minLength={12} />
              </Field>
              <Field label="Confirm passphrase" htmlFor="ex-pass2">
                <Input id="ex-pass2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={confirm.length > 0 && confirm !== passphrase} />
              </Field>
            </div>
          ) : (
            <Checkbox label="I understand the downloaded file holds every secret in clear text and I will move it to offline storage immediately" checked={plainOk} onChange={(e) => setPlainOk(e.target.checked)} />
          )}
          <Field label={`Type ${EXPORT_ACK} to confirm`} htmlFor="ex-ack">
            <Input id="ex-ack" value={ack} onChange={(e) => setAck(e.target.value)} autoComplete="off" spellCheck={false} placeholder={EXPORT_ACK} />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <Badge tone="red">plain text</Badge>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" variant="danger" loading={busy} disabled={!ready}><Download className="h-4 w-4" /> Export and download</Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (r: ImportSummary) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setFile(null); setReason(""); setAck(""); setError(null); };
  const ready = Boolean(file) && reason.trim().length >= 5 && ack.trim().toUpperCase() === IMPORT_ACK;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy || !file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("reason", reason);
      fd.set("acknowledgement", ack);
      const res = await fetch("/api/vault/import", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as ImportSummary & { error?: string };
      if (!res.ok) {
        setError(j.error ?? `Import failed (${res.status}).`);
        return;
      }
      onOpenChange(false);
      reset();
      onDone(j);
    } catch {
      setError("The upload did not complete.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent title="Import a vault backup" description="Choose the vault-backup.json from an export. Items already in the vault (same id) are skipped; missing customers and categories are created.">
        <form className="space-y-3" onSubmit={submit}>
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
          <Field label="Backup file (vault-backup.json)" htmlFor="im-file" help="If the export was passphrase-protected, decrypt and unzip it first">
            <Input id="im-file" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Reason" htmlFor="im-reason" help="Recorded in the audit trail">
            <Textarea id="im-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
          </Field>
          <Field label={`Type ${IMPORT_ACK} to confirm`} htmlFor="im-ack">
            <Input id="im-ack" value={ack} onChange={(e) => setAck(e.target.value)} autoComplete="off" spellCheck={false} placeholder={IMPORT_ACK} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={!ready}><Upload className="h-4 w-4" /> Import</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
