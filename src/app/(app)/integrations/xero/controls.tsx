"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Stethoscope, Link2, Plus, Unlink, Upload, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Select, Input, SubmitButton, FormMessage } from "@/components/ui/form";
import { createXeroContactAction, importAllRepeatingInvoicesAction, importRepeatingInvoiceAction, importAllXeroCustomersAction, importXeroContactAction, linkXeroContactAction, pushContactToXeroAction, selectTenantAction, syncXeroAction, testXeroAction, unlinkXeroContactAction } from "@/actions/xero";
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

type UnlinkedRow = { contactId: string; name: string; emailAddress: string | null; outstanding: number; overdue: number; match: { id: string; name: string; confidence: string; reason: string; alreadyLinked: boolean } | null };

export function ImportAllXeroButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" loading={pending} onClick={() => start(async () => { const r = await importAllXeroCustomersAction(); setMsg(r.ok ? `${r.data.created} companies created, ${r.data.linked} linked to existing${r.data.skipped.length ? `, ${r.data.skipped.length} skipped` : ""}` : r.error); router.refresh(); })}>
        <Plus className="h-3.5 w-3.5" /> Import all as companies
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function UnlinkedCustomersTable({ rows, canManage, currency }: { rows: UnlinkedRow[]; canManage: boolean; currency: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  const run = (contactId: string, linkExistingId?: string) =>
    start(async () => {
      const r = await importXeroContactAction(contactId, linkExistingId ?? null);
      setMsg(r.ok ? (r.data.action === "skipped" ? `Skipped: ${r.data.reason}` : null) : r.error);
      router.refresh();
    });
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">Every active Xero customer is linked to a CRM company.</p>;
  return (
    <div>
      <p className="border-b border-slate-200 px-4 py-2 text-xs text-slate-500">Xero customers with no CRM company. <strong>Create company</strong> makes a customer record from the Xero contact (name, address, VAT and company number, email, phone) and links it. Where a likely duplicate already exists you are offered <strong>Link</strong> instead.</p>
      {msg && <p className="px-4 py-2 text-sm text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>Xero customer</th>
            <th>Email</th>
            <th className="text-right">Outstanding</th>
            <th>Existing match</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.contactId}>
              <td className="font-medium">{r.name}</td>
              <td className="text-xs text-slate-600">{r.emailAddress ?? "—"}</td>
              <td className="text-right tabular-nums">
                {money(r.outstanding)}
                {r.overdue > 0 && <div className="text-[11px] text-red-600">{money(r.overdue)} overdue</div>}
              </td>
              <td className="text-xs">
                {r.match ? (
                  <span>
                    <Badge tone={r.match.confidence === "high" ? "green" : r.match.confidence === "medium" ? "amber" : "slate"}>{r.match.reason.replace(/_/g, " ")}</Badge>{" "}
                    <Link href={`/companies/${r.match.id}`} className="text-brand-700 hover:underline">
                      {r.match.name}
                    </Link>
                    {r.match.alreadyLinked && <span className="text-slate-400"> (linked to another Xero contact)</span>}
                  </span>
                ) : (
                  <span className="text-slate-400">none</span>
                )}
              </td>
              <td className="text-right">
                {canManage && (
                  <span className="inline-flex gap-1">
                    {r.match && !r.match.alreadyLinked && (
                      <Button size="sm" variant="ghost" onClick={() => run(r.contactId, r.match!.id)}>
                        <Link2 className="h-3.5 w-3.5" /> Link
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => run(r.contactId)}>
                      <Plus className="h-3.5 w-3.5" /> Create company
                    </Button>
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

type RepeatingRow = { id: string; reference: string | null; status: string; contactName: string | null; companyId: string | null; companyName: string | null; schedule: string; frequency: string | null; unsupportedReason: string | null; nextDate: string | null; lineCount: number; subTotal: number; monthlyValue: number | null; inclusive: boolean; contractId: string | null };

export function ImportAllRepeatingButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" loading={pending} onClick={() => start(async () => { const r = await importAllRepeatingInvoicesAction(); setMsg(r.ok ? `${r.data.created} draft contracts created${r.data.productsCreated ? `, ${r.data.productsCreated} catalogue products added` : ""}${r.data.skipped.length ? `, ${r.data.skipped.length} skipped` : ""}` : r.error); router.refresh(); })}>
        <FileText className="h-3.5 w-3.5" /> Import all as draft contracts
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function RepeatingInvoicesTable({ rows, canWrite, currency }: { rows: RepeatingRow[]; canWrite: boolean; currency: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);
  const run = (id: string) =>
    start(async () => {
      const r = await importRepeatingInvoiceAction(id);
      setMsg(r.ok ? (r.data.action === "skipped" ? `Skipped: ${r.data.reason}` : r.data.productsCreated ? `Draft contract created and ${r.data.productsCreated} catalogue product${r.data.productsCreated === 1 ? "" : "s"} added from Xero item codes.` : null) : r.error);
      router.refresh();
    });
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">No sales repeating invoices in Xero.</p>;
  return (
    <div>
      <p className="border-b border-slate-200 px-4 py-2 text-xs text-slate-500">Each authorised template becomes a <strong>draft</strong> contract with one recurring line per Xero line, priced tax-exclusive. Item codes that match a catalogue SKU pick up that product&apos;s pricing model, cost and device-count comparison; item codes the catalogue has never seen are <strong>added as products</strong> from the Xero item (name, sale price, purchase price as cost). Review each draft, then set it active. Nothing is activated or billed automatically.</p>
      {msg && <p className="px-4 py-2 text-sm text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Template</th>
            <th>Schedule</th>
            <th className="text-right">Per invoice (ex tax)</th>
            <th className="text-right">≈ MRR</th>
            <th>Contract</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.companyId ? (
                  <Link href={`/companies/${r.companyId}`} className="font-medium text-brand-700 hover:underline">
                    {r.companyName}
                  </Link>
                ) : (
                  <span>
                    {r.contactName} <Badge tone="amber">not linked</Badge>
                  </span>
                )}
              </td>
              <td>
                {r.reference ?? <span className="text-slate-400">no reference</span>}
                <div className="text-xs text-slate-500">
                  {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                  {r.inclusive && " · tax-inclusive"}
                  {r.status !== "AUTHORISED" && <Badge className="ml-1" tone="slate">{r.status.toLowerCase()}</Badge>}
                </div>
              </td>
              <td className="text-xs">
                {r.schedule}
                {r.unsupportedReason ? <div className="text-amber-700">{r.unsupportedReason}</div> : <div className="text-slate-500">next {r.nextDate ?? "—"}</div>}
              </td>
              <td className="text-right tabular-nums">{money(r.subTotal)}</td>
              <td className="text-right tabular-nums">{r.monthlyValue === null ? "—" : money(r.monthlyValue)}</td>
              <td>
                {r.contractId ? (
                  <Link href={`/contracts/${r.contractId}`} className="text-brand-700 hover:underline">
                    imported
                  </Link>
                ) : (
                  <span className="text-xs text-slate-400">none</span>
                )}
              </td>
              <td className="text-right">
                {canWrite && !r.contractId && r.companyId && !r.unsupportedReason && r.status === "AUTHORISED" && (
                  <Button size="sm" variant="ghost" onClick={() => run(r.id)}>
                    <FileText className="h-3.5 w-3.5" /> Create draft contract
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
