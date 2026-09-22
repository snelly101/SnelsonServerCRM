"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Stethoscope, Link2, Plus, Unlink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Select, Input, SubmitButton, FormMessage } from "@/components/ui/form";
import { createXeroContactAction, linkXeroContactAction, pushContactToXeroAction, selectTenantAction, syncXeroAction, testXeroAction, unlinkXeroContactAction } from "@/actions/xero";
import { saveIntegrationConfigAction } from "@/actions/integrations";
import type { XeroMatch } from "@/services/xero";

export function XeroTestButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await testXeroAction(); setMsg(r.ok ? { ok: r.data.ok, text: r.data.message } : { ok: false, text: r.error }); router.refresh(); })}>
        <Stethoscope className="h-3.5 w-3.5" /> Test
      </Button>
      {msg && <span className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}
    </span>
  );
}

export function XeroSyncButton({ full = false, label }: { full?: boolean; label?: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await syncXeroAction(full); setMsg(r.ok ? r.data.message : r.error); router.refresh(); })}>
        <RefreshCw className="h-3.5 w-3.5" /> {label ?? (full ? "Full reconciliation" : "Sync now")}
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function TenantPicker({ tenants }: { tenants: { tenantId: string; tenantName: string }[] }) {
  const [tenantId, setTenantId] = useState(tenants[0]?.tenantId ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  if (!tenants.length) return null;
  return (
    <div className="rounded-md border border-brand-200 bg-brand-50 p-3">
      <p className="mb-2 text-sm font-medium text-slate-800">Choose the Xero organisation to use</p>
      {error && <p className="mb-2 text-xs text-red-700">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Organisation" htmlFor="tenant">
          <Select id="tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantName}
              </option>
            ))}
          </Select>
        </Field>
        <Button loading={pending} onClick={() => start(async () => { const r = await selectTenantAction(tenantId); if (!r.ok) return setError(r.error); router.push("/integrations/xero?connected=1"); router.refresh(); })}>
          Use this organisation
        </Button>
      </div>
    </div>
  );
}

export function XeroConfigForm({ accounts, taxRates, themes, config, readOnly }: { accounts: { Code?: string; Name: string }[]; taxRates: { TaxType: string; Name: string; EffectiveRate?: number }[]; themes: { BrandingThemeID: string; Name: string }[]; config: { defaultAccountCode?: string; hardwareAccountCode?: string; defaultTaxType?: string; dueDays?: number; brandingThemeId?: string }; readOnly: boolean }) {
  const [result, formAction] = useActionState(saveIntegrationConfigAction.bind(null, "xero"), null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <Field label="Sales account code (services)" htmlFor="x-acc">
          <Select id="x-acc" name="defaultAccountCode" defaultValue={config.defaultAccountCode ?? ""}>
            <option value="">— choose —</option>
            {accounts.map((a) => (
              <option key={a.Code} value={a.Code}>
                {a.Code} · {a.Name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Account code for hardware" htmlFor="x-acc-hw">
          <Select id="x-acc-hw" name="hardwareAccountCode" defaultValue={config.hardwareAccountCode ?? ""}>
            <option value="">Same as services</option>
            {accounts.map((a) => (
              <option key={a.Code} value={a.Code}>
                {a.Code} · {a.Name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tax rate" htmlFor="x-tax">
          <Select id="x-tax" name="defaultTaxType" defaultValue={config.defaultTaxType ?? ""}>
            <option value="">— choose —</option>
            {taxRates.map((t) => (
              <option key={t.TaxType} value={t.TaxType}>
                {t.Name}
                {t.EffectiveRate !== undefined ? ` (${t.EffectiveRate}%)` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Payment terms (days)" htmlFor="x-due">
          <Input id="x-due" name="dueDays" type="number" min={0} max={120} defaultValue={config.dueDays ?? 30} />
        </Field>
        <Field label="Branding theme" htmlFor="x-theme">
          <Select id="x-theme" name="brandingThemeId" defaultValue={config.brandingThemeId ?? ""}>
            <option value="">Xero default</option>
            {themes.map((t) => (
              <option key={t.BrandingThemeID} value={t.BrandingThemeID}>
                {t.Name}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>
      {!readOnly && <SubmitButton size="sm">Save defaults</SubmitButton>}
    </form>
  );
}

type Row = { id: string; name: string; status: string; link: { externalId: string; externalName: string | null; externalStatus: string } | null; suggestions: XeroMatch[] };

export function MappingTable({ rows, canManage, configured }: { rows: Row[]; canManage: boolean; configured: boolean }) {
  const [filter, setFilter] = useState<"all" | "unlinked" | "linked">("all");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const shown = rows.filter((r) => (filter === "all" ? true : filter === "linked" ? Boolean(r.link) : !r.link));
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2 text-sm">
        {(["all", "unlinked", "linked"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded px-2 py-0.5 ${filter === f ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {f}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">Suggestions are by company number, VAT number, email domain and name. Nothing is linked until you click Link.</span>
      </div>
      {msg && <p className="px-4 py-2 text-sm text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>CRM company</th>
            <th>Xero contact</th>
            <th>Suggestions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/companies/${r.id}`} className="font-medium text-brand-700 hover:underline">
                  {r.name}
                </Link>
                <div className="text-xs text-slate-500">{r.status}</div>
              </td>
              <td>
                {r.link ? (
                  <span>
                    {r.link.externalName ?? r.link.externalId}
                    {r.link.externalStatus !== "active" && <Badge className="ml-1" tone="amber">{r.link.externalStatus}</Badge>}
                  </span>
                ) : (
                  <span className="text-xs text-amber-700">not linked</span>
                )}
              </td>
              <td>
                {r.link ? null : r.suggestions.length === 0 ? (
                  <span className="text-xs text-slate-400">none</span>
                ) : (
                  <ul className="space-y-1">
                    {r.suggestions.slice(0, 3).map((s) => (
                      <li key={s.contactId} className="flex items-center gap-2 text-xs">
                        <Badge tone={s.confidence === "high" ? "green" : s.confidence === "medium" ? "amber" : "slate"}>{s.reason.replace("_", " ")}</Badge>
                        <span>{s.name}</span>
                        {canManage && (
                          <button type="button" className="inline-flex items-center gap-0.5 text-brand-700 hover:underline" onClick={() => run(() => linkXeroContactAction(r.id, s.contactId))}>
                            <Link2 className="h-3 w-3" /> Link
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="text-right">
                {canManage && configured && (
                  <span className="inline-flex gap-1">
                    {r.link ? (
                      <>
                        <Button size="sm" variant="ghost" title="Push CRM email/phone to Xero (refused if Xero changed first)" onClick={() => run(() => pushContactToXeroAction(r.id))}>
                          <Upload className="h-3.5 w-3.5" /> Push
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => run(() => unlinkXeroContactAction(r.id))}>
                          <Unlink className="h-3.5 w-3.5" /> Unlink
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" title="Create a new Xero contact from CRM data (refused if a likely duplicate exists)" onClick={() => run(() => createXeroContactAction(r.id))}>
                        <Plus className="h-3.5 w-3.5" /> Create in Xero
                      </Button>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
