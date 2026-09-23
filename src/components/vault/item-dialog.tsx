"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound, Plus, Trash2, Wand2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Checkbox } from "@/components/ui/form";
import { createVaultItemAction, generatePasswordAction, updateVaultItemAction } from "@/actions/vault";
import type { VaultItemFormInput, VaultSecretsFormInput } from "@/actions/vault";

export type VaultItemMeta = { id: string; companyId: string; siteId: string | null; categoryId: string; name: string; username: string | null; url: string | null; reference: string | null; tags: string[]; isFavourite: boolean; reviewAt: string | null; expiresAt: string | null; secretKinds: string[] };
type Custom = { label: string; value: string; secret: boolean };

function strengthLabel(pw: string) {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const bits = pool ? Math.round(pw.length * Math.log2(pool)) : 0;
  return bits === 0 ? null : bits < 40 ? { label: "weak", tone: "bg-red-500", pct: 25 } : bits < 60 ? { label: "fair", tone: "bg-amber-500", pct: 50 } : bits < 90 ? { label: "good", tone: "bg-green-500", pct: 75 } : { label: "strong", tone: "bg-green-600", pct: 100 };
}

export function VaultItemDialog({ open, onOpenChange, companyId, item, categories, sites }: { open: boolean; onOpenChange: (o: boolean) => void; companyId: string; item: VaultItemMeta | null; categories: { id: string; name: string }[]; sites: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [meta, setMeta] = useState<Omit<VaultItemFormInput, "companyId">>({ siteId: item?.siteId ?? "", categoryId: item?.categoryId ?? categories[0]?.id ?? "", name: item?.name ?? "", username: item?.username ?? "", url: item?.url ?? "", reference: item?.reference ?? "", tags: item?.tags ?? [], isFavourite: item?.isFavourite ?? false, reviewAt: item?.reviewAt ?? "", expiresAt: item?.expiresAt ?? "" });
  const [tagsText, setTagsText] = useState((item?.tags ?? []).join(", "));
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [notes, setNotes] = useState("");
  const [totp, setTotp] = useState("");
  const [recovery, setRecovery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [custom, setCustom] = useState<Custom[]>([]);
  const [clear, setClear] = useState<NonNullable<VaultSecretsFormInput["clear"]>>([]);
  const has = (k: string) => (item?.secretKinds ?? []).some((s) => s === k || s.startsWith(`${k}:`));
  const strength = strengthLabel(password);

  const toggleClear = (k: NonNullable<VaultSecretsFormInput["clear"]>[number], on: boolean) => setClear((c) => (on ? [...new Set([...c, k])] : c.filter((x) => x !== k)));

  const submit = () =>
    start(async () => {
      const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
      const secrets: VaultSecretsFormInput = { password: password || null, notes: notes || null, totp: totp || null, recoveryCodes: recovery ? recovery.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null, apiKey: apiKey || null, custom: custom.length ? custom : item ? undefined : null, clear };
      const r = item ? await updateVaultItemAction(item.id, companyId, { ...meta, tags }, secrets) : await createVaultItemAction({ ...meta, companyId, tags }, secrets);
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      setPassword(""); setNotes(""); setTotp(""); setRecovery(""); setApiKey(""); setCustom([]); setClear([]);
      onOpenChange(false);
      router.refresh();
    });

  const generate = () =>
    start(async () => {
      const r = await generatePasswordAction({ length: 20 });
      if (r.ok) {
        setPassword(r.data.password);
        setShowPw(true);
      }
    });

  const err = (k: string) => fieldErrors[k];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={item ? `Edit: ${item.name}` : "New vault item"} description={item ? "Secret fields left blank stay as they are. Tick “remove” to delete one." : "Secrets are encrypted before they are stored. Nothing here is kept in your browser."} wide>
        <form
          className="space-y-4"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="v-name" required error={err("name")}>
              <Input id="v-name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} required maxLength={200} placeholder="e.g. Edge firewall admin" />
            </Field>
            <Field label="Category" htmlFor="v-cat" required error={err("categoryId")}>
              <Select id="v-cat" value={meta.categoryId} onChange={(e) => setMeta({ ...meta, categoryId: e.target.value })}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Username / login" htmlFor="v-user">
              <Input id="v-user" value={meta.username ?? ""} onChange={(e) => setMeta({ ...meta, username: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="URL / portal" htmlFor="v-url" error={err("url")}>
              <Input id="v-url" value={meta.url ?? ""} onChange={(e) => setMeta({ ...meta, url: e.target.value })} placeholder="https://" />
            </Field>
            <Field label="Account / reference number" htmlFor="v-ref">
              <Input id="v-ref" value={meta.reference ?? ""} onChange={(e) => setMeta({ ...meta, reference: e.target.value })} />
            </Field>
            <Field label="Site" htmlFor="v-site">
              <Select id="v-site" value={meta.siteId ?? ""} onChange={(e) => setMeta({ ...meta, siteId: e.target.value })}>
                <option value="">Whole customer</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Tags" htmlFor="v-tags" help="Comma separated">
              <Input id="v-tags" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="core, hq" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Review on" htmlFor="v-review"><Input id="v-review" type="date" value={meta.reviewAt ?? ""} onChange={(e) => setMeta({ ...meta, reviewAt: e.target.value })} /></Field>
              <Field label="Expires on" htmlFor="v-exp"><Input id="v-exp" type="date" value={meta.expiresAt ?? ""} onChange={(e) => setMeta({ ...meta, expiresAt: e.target.value })} /></Field>
            </div>
          </div>

          <fieldset className="rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-sm font-medium text-slate-700"><KeyRound className="mr-1 inline h-4 w-4" />Secrets</legend>
            <div className="space-y-3">
              <Field label={has("password") ? "Password (leave blank to keep)" : "Password"} htmlFor="v-pw" error={err("password")}>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input id="v-pw" type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" spellCheck={false} className="pr-9 font-mono" />
                    <button type="button" className="absolute right-2 top-2 text-slate-500 hover:text-slate-800" onClick={() => setShowPw((s) => !s)} aria-label={showPw ? "Hide password" : "Show password"}>{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                  <Button type="button" variant="secondary" onClick={generate} loading={pending}><Wand2 className="h-4 w-4" /> Generate</Button>
                </div>
                {strength && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <div className="h-1.5 w-32 rounded bg-slate-100"><div className={`h-1.5 rounded ${strength.tone}`} style={{ width: `${strength.pct}%` }} /></div>
                    {strength.label}
                  </div>
                )}
                {has("password") && <Checkbox className="mt-1" label="Remove the stored password" checked={clear.includes("password")} onChange={(e) => toggleClear("password", e.target.checked)} />}
              </Field>
              <Field label={has("notes") ? "Secure notes (leave blank to keep)" : "Secure notes"} htmlFor="v-notes">
                <Textarea id="v-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                {has("notes") && <Checkbox className="mt-1" label="Remove the stored notes" checked={clear.includes("notes")} onChange={(e) => toggleClear("notes", e.target.checked)} />}
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={has("totp") ? "Authenticator (TOTP) secret (leave blank to keep)" : "Authenticator (TOTP) secret"} htmlFor="v-totp" help="Base32 key or otpauth:// URI" error={err("totp")}>
                  <Input id="v-totp" value={totp} onChange={(e) => setTotp(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
                  {has("totp") && <Checkbox className="mt-1" label="Remove the authenticator secret" checked={clear.includes("totp")} onChange={(e) => toggleClear("totp", e.target.checked)} />}
                </Field>
                <Field label={has("api_key") ? "API key (leave blank to keep)" : "API key"} htmlFor="v-api">
                  <Input id="v-api" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
                  {has("api_key") && <Checkbox className="mt-1" label="Remove the API key" checked={clear.includes("api_key")} onChange={(e) => toggleClear("api_key", e.target.checked)} />}
                </Field>
              </div>
              <Field label={has("recovery_codes") ? "Recovery codes, one per line (leave blank to keep)" : "Recovery codes, one per line"} htmlFor="v-rec">
                <Textarea id="v-rec" rows={3} value={recovery} onChange={(e) => setRecovery(e.target.value)} className="font-mono" />
                {has("recovery_codes") && <Checkbox className="mt-1" label="Remove the recovery codes" checked={clear.includes("recovery_codes")} onChange={(e) => toggleClear("recovery_codes", e.target.checked)} />}
              </Field>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="field-label">Custom secure fields{has("custom") ? " (replaces the existing set when any are entered)" : ""}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setCustom((c) => [...c, { label: "", value: "", secret: true }])}><Plus className="h-3.5 w-3.5" /> Add field</Button>
                </div>
                {custom.map((c, i) => (
                  <div key={i} className="mb-2 flex items-center gap-2">
                    <Input aria-label="Field label" placeholder="Label" value={c.label} onChange={(e) => setCustom((arr) => arr.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="w-40" />
                    <Input aria-label="Field value" placeholder="Value" type={c.secret ? "password" : "text"} value={c.value} onChange={(e) => setCustom((arr) => arr.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} autoComplete="off" className="flex-1 font-mono" />
                    <Checkbox label="secret" checked={c.secret} onChange={(e) => setCustom((arr) => arr.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))} />
                    <button type="button" className="text-slate-400 hover:text-red-600" aria-label="Remove field" onClick={() => setCustom((arr) => arr.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
              </div>
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={pending}>{item ? "Save changes" : "Add to vault"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
