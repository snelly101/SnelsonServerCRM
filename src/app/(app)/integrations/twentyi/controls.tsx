"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Stethoscope, Link2, Unlink, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Select, Input, SubmitButton, FormMessage, Checkbox } from "@/components/ui/form";
import { expiryTone, fmtBytes, HOSTING_KIND_LABEL, HOSTING_KIND_TONE } from "@/lib/hosting-format";
import { connectTwentyIAction, linkHostingItemAction, saveTwentyIConfigAction, setHostingBillingLineAction, syncTwentyIAction, testTwentyIAction, unlinkHostingItemAction } from "@/actions/twentyi";

export function TwentyITestButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await testTwentyIAction(); setMsg(r.ok ? { ok: r.data.ok, text: r.data.message } : { ok: false, text: r.error }); router.refresh(); })}>
        <Stethoscope className="h-3.5 w-3.5" /> Test
      </Button>
      {msg && <span className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}
    </span>
  );
}

export function TwentyISyncButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await syncTwentyIAction(); setMsg(r.ok ? r.data.message : r.error); router.refresh(); })}>
        <RefreshCw className="h-3.5 w-3.5" /> Sync now
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function TwentyIConnectForm({ keyPresent }: { keyPresent: boolean }) {
  const [result, formAction] = useActionState(connectTwentyIAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <Field label="General API key" htmlFor="t-key" help="Stored encrypted on the server. Never shown again.">
        <Input id="t-key" name="apiKey" type="password" required autoComplete="new-password" placeholder={keyPresent ? "Paste a new key to replace the stored one" : "Paste the key from My20i"} />
      </Field>
      <p className="text-xs text-slate-500">
        In My20i: <strong>Reseller → API</strong> → copy the <strong>General API key</strong>. The CRM sends it as a bearer token to <code>api.20i.com</code> and only ever reads: packages, domains, mailboxes and usage. It never provisions, suspends, renews or changes DNS.
      </p>
      <SubmitButton size="sm">{keyPresent ? "Replace key" : "Verify and connect"}</SubmitButton>
    </form>
  );
}

export function TwentyIConfigForm({ expiryReminderDays, autoLink, syncMailboxes, readOnly }: { expiryReminderDays: number; autoLink: boolean; syncMailboxes: boolean; readOnly: boolean }) {
  const [result, formAction] = useActionState(saveTwentyIConfigAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <fieldset disabled={readOnly} className="space-y-3">
        <Field label="Expiry reminder window (days)" htmlFor="t-days" help="A task is raised for each domain or certificate expiring within this many days.">
          <Input id="t-days" name="expiryReminderDays" type="number" min={1} max={365} defaultValue={expiryReminderDays} className="w-28" />
        </Field>
        <Checkbox name="autoLink" value="true" defaultChecked={autoLink} label="Link packages and domains to a company automatically when the domain matches exactly one company (website or contact email domain)" />
        <Checkbox name="syncMailboxes" value="true" defaultChecked={syncMailboxes} label="Mirror mailboxes (one request per package name; turn off for very large accounts)" />
      </fieldset>
      {!readOnly && <SubmitButton size="sm">Save</SubmitButton>}
    </form>
  );
}

type Child = { id: string; kind: string; name: string; externalStatus: string };
type ItemRow = {
  id: string;
  kind: string;
  externalId: string;
  name: string;
  typeName: string | null;
  enabled: boolean | null;
  expiresOn: string | null;
  diskUsedBytes: number | null;
  companyId: string | null;
  companyName: string | null;
  matchSource: string | null;
  contractLineId: string | null;
  externalStatus: string;
  suggestions: { id: string; name: string; reason: "domain" | "name" }[];
  children: Child[];
  details: Record<string, unknown> | null;
};

export function HostingMappingTable({ rows, companies, canManage }: { rows: ItemRow[]; companies: { id: string; name: string }[]; canManage: boolean }) {
  const [filter, setFilter] = useState<"all" | "unlinked" | "linked" | "expiring">("all");
  const [kind, setKind] = useState<"all" | "package" | "domain">("all");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const router = useRouter();
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const shown = rows.filter((r) => (kind === "all" || r.kind === kind) && (filter === "all" ? true : filter === "linked" ? Boolean(r.companyId) : filter === "unlinked" ? !r.companyId : Boolean(r.expiresOn && r.expiresOn <= soon)));
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2 text-sm">
        {(["all", "unlinked", "linked", "expiring"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded px-2 py-0.5 ${filter === f ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {f}
          </button>
        ))}
        <span className="mx-1 text-slate-300">|</span>
        {(["all", "package", "domain"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={`rounded px-2 py-0.5 ${kind === k ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {k === "all" ? "packages + domains" : `${k}s`}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">Exact domain matches are linked automatically at sync time; name matches are only suggestions. Mailboxes follow their package.</span>
      </div>
      {msg && <p className="px-4 py-2 text-sm text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>Item</th>
            <th>Type</th>
            <th>Expiry / usage</th>
            <th>CRM company</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-sm text-slate-500">
                {rows.length === 0 ? "Nothing mirrored yet. Run a sync." : "Nothing matches this filter."}
              </td>
            </tr>
          )}
          {shown.map((r) => {
            const exp = expiryTone(r.expiresOn);
            const names = ((r.details?.names as string[] | undefined) ?? []).filter((n) => n !== r.name);
            return (
              <tr key={r.id} className="align-top">
                <td>
                  <div className="flex items-center gap-1.5 font-medium">
                    <Badge tone={HOSTING_KIND_TONE[r.kind]}>{HOSTING_KIND_LABEL[r.kind]}</Badge>
                    {r.name}
                  </div>
                  <div className="text-xs text-slate-500">
                    id {r.externalId}
                    {names.length > 0 && ` · also ${names.join(", ")}`}
                    {r.children.length > 0 && ` · ${r.children.length} mailbox${r.children.length === 1 ? "" : "es"}`}
                    {r.enabled === false && <Badge className="ml-1" tone="amber">disabled at 20i</Badge>}
                    {r.externalStatus !== "active" && <Badge className="ml-1" tone="red">gone from 20i</Badge>}
                  </div>
                </td>
                <td className="text-xs text-slate-600">{r.typeName ?? "—"}</td>
                <td className="text-xs">
                  {r.kind === "domain" ? (
                    exp ? (
                      <span className="flex items-center gap-1">
                        {r.expiresOn} <Badge tone={exp.tone}>{exp.label}</Badge>
                      </span>
                    ) : (
                      <span className="text-slate-400">no expiry date</span>
                    )
                  ) : (
                    <span className="text-slate-600">{r.diskUsedBytes === null ? "usage n/a" : `${fmtBytes(r.diskUsedBytes)} used`}</span>
                  )}
                </td>
                <td>
                  {r.companyId ? (
                    <span className="flex items-center gap-1">
                      <Link href={`/companies/${r.companyId}?tab=hosting`} className="text-brand-700 hover:underline">
                        {r.companyName}
                      </Link>
                      {r.matchSource === "auto" && <Badge tone="green">auto</Badge>}
                      {!r.contractLineId && <span title="No contract line bills this item yet"><Badge tone="amber">not billed</Badge></span>}
                    </span>
                  ) : canManage ? (
                    <div className="space-y-1">
                      {r.suggestions.length > 0 && (
                        <ul className="space-y-0.5">
                          {r.suggestions.map((s) => (
                            <li key={s.id} className="flex items-center gap-2 text-xs">
                              <Badge tone={s.reason === "domain" ? "green" : "amber"}>{s.reason === "domain" ? "domain match" : "similar name"}</Badge>
                              <span>{s.name}</span>
                              <button type="button" className="inline-flex items-center gap-0.5 text-brand-700 hover:underline" onClick={() => run(() => linkHostingItemAction(r.id, s.id))}>
                                <Link2 className="h-3 w-3" /> Link
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-1">
                        <Select aria-label={`Company for ${r.name}`} className="h-8 w-auto max-w-[220px] text-xs" value={choice[r.id] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [r.id]: e.target.value }))}>
                          <option value="">— choose company —</option>
                          {companies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                        <Button size="sm" variant="ghost" disabled={!choice[r.id]} onClick={() => run(() => linkHostingItemAction(r.id, choice[r.id]))}>
                          <Link2 className="h-3.5 w-3.5" /> Link
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-amber-700">not linked</span>
                  )}
                </td>
                <td className="text-right">
                  {canManage && r.companyId && (
                    <Button size="sm" variant="ghost" onClick={() => run(() => unlinkHostingItemAction(r.id))}>
                      <Unlink className="h-3.5 w-3.5" /> Unlink
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Company page: choose which contract line bills a hosting item. */
export function BillingLineSelect({ itemId, value, lines, canEdit }: { itemId: string; value: string | null; lines: { id: string; description: string; contractName: string; contractStatus: string }[]; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const current = lines.find((l) => l.id === value);
  if (!canEdit) return <span className="text-xs">{current ? `${current.description} (${current.contractName})` : <span className="text-amber-700">not billed</span>}</span>;
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <Select
        aria-label="Billed by contract line"
        className={`py-1 text-xs ${pending ? "opacity-60" : ""}`}
        value={value ?? ""}
        onChange={(e) =>
          start(async () => {
            const r = await setHostingBillingLineAction(itemId, e.target.value || null);
            setError(r.ok ? null : r.error);
            router.refresh();
          })
        }
      >
        <option value="">— not billed —</option>
        {lines.map((l) => (
          <option key={l.id} value={l.id} title={l.contractName}>
            {l.description}{l.contractStatus === "draft" ? " (draft)" : ""} · {l.contractName}
          </option>
        ))}
      </Select>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

export function ConsoleLink({ href, label = "Open in My20i" }: { href: string | null; label?: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
      <ExternalLink className="h-3 w-3" /> {label}
    </a>
  );
}
