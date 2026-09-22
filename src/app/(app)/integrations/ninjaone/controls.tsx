"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Stethoscope, Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Select, Input, SubmitButton, FormMessage, Checkbox } from "@/components/ui/form";
import { NINJA_NODE_CLASSES as NODE_CLASSES } from "@/connectors/ninjaone/types";
import { connectNinjaOneAction, linkLocationAction, linkOrganizationAction, saveNinjaConfigAction, syncNinjaOneAction, testNinjaOneAction, unlinkLocationAction, unlinkOrganizationAction } from "@/actions/ninjaone";

export function NinjaTestButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await testNinjaOneAction(); setMsg(r.ok ? { ok: r.data.ok, text: r.data.message } : { ok: false, text: r.error }); router.refresh(); })}>
        <Stethoscope className="h-3.5 w-3.5" /> Test
      </Button>
      {msg && <span className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}
    </span>
  );
}

export function NinjaSyncButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await syncNinjaOneAction(); setMsg(r.ok ? r.data.message : r.error); router.refresh(); })}>
        <RefreshCw className="h-3.5 w-3.5" /> Sync now
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

const REGIONS: { value: string; label: string }[] = [
  { value: "eu", label: "EU · eu.ninjarmm.com" },
  { value: "us", label: "US · app.ninjarmm.com" },
  { value: "us2", label: "US 2 · us2.ninjarmm.com" },
  { value: "ca", label: "Canada · ca.ninjarmm.com" },
  { value: "oc", label: "Oceania · oc.ninjarmm.com" },
];

export function NinjaConnectForm({ region, clientIdMasked }: { region: string; clientIdMasked: string | null }) {
  const [result, formAction] = useActionState(connectNinjaOneAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Region" htmlFor="n-region" help="The instance you sign in to.">
          <Select id="n-region" name="region" defaultValue={region}>
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Client ID" htmlFor="n-cid" help={clientIdMasked ? `Currently ${clientIdMasked}` : undefined}>
          <Input id="n-cid" name="clientId" required autoComplete="off" placeholder="API client id" />
        </Field>
        <Field label="Client secret" htmlFor="n-sec" help="Stored encrypted on the server. Never shown again.">
          <Input id="n-sec" name="clientSecret" type="password" required autoComplete="new-password" />
        </Field>
      </div>
      <p className="text-xs text-slate-500">
        In NinjaOne: Administration → Apps → API → Client app IDs → Add. Choose <strong>API Services (machine-to-machine)</strong>, grant only the <strong>Monitoring</strong> scope, and set the redirect URI to anything (unused). The CRM never requests Management or Control scopes.
      </p>
      <SubmitButton size="sm">{clientIdMasked ? "Replace credentials" : "Verify and connect"}</SubmitButton>
    </form>
  );
}


export function NinjaConfigForm({ billableNodeClasses, approvedOnly, readOnly }: { billableNodeClasses: string[]; approvedOnly: boolean; readOnly: boolean }) {
  const [result, formAction] = useActionState(saveNinjaConfigAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <fieldset disabled={readOnly}>
        <p className="mb-1 text-sm font-medium text-slate-700">Device classes that count towards per-device lines</p>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {NODE_CLASSES.map((c) => (
            <Checkbox key={c} name="billableNodeClasses[]" value={c} defaultChecked={billableNodeClasses.includes(c)} label={c.toLowerCase().replace(/_/g, " ")} />
          ))}
        </div>
        <div className="mt-3">
          <Checkbox name="approvedOnly" value="true" defaultChecked={approvedOnly} label="Only count devices NinjaOne has approved (ignore pending / rejected)" />
        </div>
      </fieldset>
      {!readOnly && <SubmitButton size="sm">Save and re-check</SubmitButton>}
    </form>
  );
}

type Loc = { id: string; locationId: string; name: string; address: string | null; link: { localId: string; externalName: string | null } | null; siteOptions: { id: string; name: string }[] };
type OrgRow = { id: string; orgId: string; name: string; externalStatus: string; deviceCount: number; link: { localId: string } | null; suggestions: { id: string; name: string; score: number }[]; locations: Loc[] };

export function OrgMappingTable({ rows, companies, canManage }: { rows: OrgRow[]; companies: { id: string; name: string }[]; canManage: boolean }) {
  const [filter, setFilter] = useState<"all" | "unlinked" | "linked">("all");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const router = useRouter();
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
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
        <span className="ml-auto text-xs text-slate-500">Suggestions are by name only and are never applied automatically. Link locations to sites for site-scoped contract lines.</span>
      </div>
      {msg && <p className="px-4 py-2 text-sm text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>NinjaOne organisation</th>
            <th className="text-right">Devices</th>
            <th>CRM company</th>
            <th>Locations → sites</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-sm text-slate-500">
                No organisations mirrored yet. Run a sync.
              </td>
            </tr>
          )}
          {shown.map((r) => (
            <tr key={r.id} className="align-top">
              <td>
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-slate-500">
                  id {r.orgId}
                  {r.externalStatus !== "active" && <Badge className="ml-1" tone="amber">{r.externalStatus} in NinjaOne</Badge>}
                </div>
              </td>
              <td className="text-right tabular-nums">{r.deviceCount}</td>
              <td>
                {r.link ? (
                  <Link href={`/companies/${r.link.localId}`} className="text-brand-700 hover:underline">
                    {companyName(r.link.localId)}
                  </Link>
                ) : canManage ? (
                  <div className="space-y-1">
                    {r.suggestions.length > 0 && (
                      <ul className="space-y-0.5">
                        {r.suggestions.map((s) => (
                          <li key={s.id} className="flex items-center gap-2 text-xs">
                            <Badge tone={s.score >= 2 ? "green" : "amber"}>{s.score >= 2 ? "exact name" : "similar name"}</Badge>
                            <span>{s.name}</span>
                            <button type="button" className="inline-flex items-center gap-0.5 text-brand-700 hover:underline" onClick={() => run(() => linkOrganizationAction(r.orgId, s.id))}>
                              <Link2 className="h-3 w-3" /> Link
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-1">
                      <Select aria-label={`Company for ${r.name}`} className="h-8 w-auto max-w-[220px] text-xs" value={choice[r.orgId] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [r.orgId]: e.target.value }))}>
                        <option value="">— choose company —</option>
                        {companies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                      <Button size="sm" variant="ghost" disabled={!choice[r.orgId]} onClick={() => run(() => linkOrganizationAction(r.orgId, choice[r.orgId]))}>
                        <Link2 className="h-3.5 w-3.5" /> Link
                      </Button>
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-amber-700">not linked</span>
                )}
              </td>
              <td>
                {r.locations.length === 0 ? (
                  <span className="text-xs text-slate-400">no locations</span>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {r.locations.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-1">
                        <span className="text-slate-700">{l.name}</span>
                        {l.link ? (
                          <>
                            <span className="text-slate-400">→</span>
                            <span>{l.siteOptions.find((s) => s.id === l.link!.localId)?.name ?? "site"}</span>
                            {canManage && (
                              <button type="button" className="text-slate-500 hover:underline" onClick={() => run(() => unlinkLocationAction(l.link!.localId))}>
                                unlink
                              </button>
                            )}
                          </>
                        ) : r.link && canManage && l.siteOptions.length > 0 ? (
                          <Select aria-label={`Site for ${l.name}`} className="h-7 w-auto text-xs" value="" onChange={(e) => e.target.value && run(() => linkLocationAction(l.locationId, e.target.value))}>
                            <option value="">→ link to site…</option>
                            {l.siteOptions.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="text-slate-400">{r.link ? "no sites to link" : "not linked"}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="text-right">
                {canManage && r.link && (
                  <Button size="sm" variant="ghost" onClick={() => run(() => unlinkOrganizationAction(r.link!.localId))}>
                    <Unlink className="h-3.5 w-3.5" /> Unlink
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
