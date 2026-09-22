"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ExternalLink, FileText, Plus } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Select, Input, Checkbox, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { createProposalAction } from "@/actions/integrations";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";

export type ProposalRow = {
  externalId: string;
  subjectLine: string | null;
  status: string;
  viewUrl: string | null;
  sentAt: Date | null;
  openedAt: Date | null;
  signedAt: Date | null;
  signedBy: string | null;
  monthlyTotal: string | null;
  oneOffTotal: string | null;
  currencyCode: string | null;
  fetchedAt: Date;
  acceptanceProcessedAt: Date | null;
};

const TONE: Record<string, string> = { draft: "slate", sent: "blue", opened: "indigo", signed: "green", paid: "teal", unknown: "slate" };
const STEPS = ["draft", "sent", "opened", "signed"];

export function ProposalCard({
  opportunityId,
  proposals,
  canCreate,
  configured,
  demo,
  templates,
  defaultTemplateId,
  contacts,
  mergeTags,
  settings,
  opportunityOpen,
}: {
  opportunityId: string;
  proposals: ProposalRow[];
  canCreate: boolean;
  configured: boolean;
  demo: boolean;
  templates: { id: string; name: string }[];
  defaultTemplateId: string;
  contacts: { id: string; name: string; email: string | null; roles: string[] }[];
  mergeTags: { tag: string; name: string; fallback: string | null }[];
  settings: DisplaySettings;
  opportunityOpen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(createProposalAction, null);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const nextVersion = proposals.length + 1;

  return (
    <div className="space-y-3">
      {demo && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Demo adapter: proposals created here are synthetic and never sent.</p>}
      {proposals.length === 0 ? (
        <p className="text-sm text-slate-500">{configured ? "No proposal yet." : "Better Proposals is not connected."}</p>
      ) : (
        <ul className="space-y-3">
          {proposals.map((p) => {
            const stepIdx = STEPS.indexOf(p.status === "paid" ? "signed" : p.status);
            const stale = Date.now() - new Date(p.fetchedAt).getTime() > 45 * 60_000;
            return (
              <li key={p.externalId} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="truncate">{p.subjectLine ?? `Proposal ${p.externalId}`}</span>
                    </div>
                    <div className="text-xs text-slate-500">#{p.externalId}</div>
                  </div>
                  <Badge tone={TONE[p.status]}>{p.status}</Badge>
                </div>
                <ol className="mt-2 flex items-center gap-1 text-[11px]">
                  {STEPS.map((s, i) => (
                    <li key={s} className={`flex-1 rounded px-1.5 py-0.5 text-center ${i <= stepIdx ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500"}`}>
                      {s}
                    </li>
                  ))}
                </ol>
                <dl className="mt-2 grid grid-cols-3 gap-1 text-[11px] text-slate-600">
                  <div>
                    <dt className="text-slate-400">Sent</dt>
                    <dd>{fmtDate(p.sentAt, settings)}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Opened</dt>
                    <dd>{fmtDate(p.openedAt, settings)}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400">Signed</dt>
                    <dd>
                      {fmtDate(p.signedAt, settings)}
                      {p.signedBy ? ` · ${p.signedBy}` : ""}
                    </dd>
                  </div>
                </dl>
                {(p.monthlyTotal || p.oneOffTotal) && (
                  <div className="mt-1 text-xs text-slate-600">
                    {p.monthlyTotal && <>Monthly {fmtMoney(p.monthlyTotal, p.currencyCode ?? settings.currency)} </>}
                    {p.oneOffTotal && <>· One-off {fmtMoney(p.oneOffTotal, p.currencyCode ?? settings.currency)}</>}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                  <span title="Status is polled every 15 minutes">{stale ? "⚠ cached, may be stale" : "cached"} · updated {fmtDate(p.fetchedAt, settings)}</span>
                  {p.viewUrl && (
                    <a href={p.viewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                      Open in Better Proposals <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                {p.acceptanceProcessedAt && <p className="mt-1 text-[11px] text-green-700">Accepted: opportunity won, onboarding and contract created.</p>}
              </li>
            );
          })}
        </ul>
      )}
      {canCreate && configured && opportunityOpen && (
        <Dialog open={open} onOpenChange={setOpen}>
          <Button size="sm" variant={proposals.length ? "secondary" : "primary"} onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> {proposals.length ? "Create another version" : "Create proposal"}
          </Button>
          <DialogContent title="Create proposal in Better Proposals" description="Creates a draft from the template with the customer and contact details. Pricing and sending are done in Better Proposals.">
            <form action={formAction} className="space-y-3">
              <input type="hidden" name="opportunityId" value={opportunityId} />
              <input type="hidden" name="version" value={nextVersion} />
              <FormMessage result={result && !result.ok ? result : null} />
              <Field label="Template" htmlFor="pp-template" error={fieldErrors(result, "templateId")}>
                <Select id="pp-template" name="templateId" defaultValue={defaultTemplateId}>
                  <option value="">Better Proposals default</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <fieldset>
                <legend className="field-label">Recipients (first is the signer)</legend>
                {contacts.length === 0 && <p className="text-xs text-red-600">This company has no contacts with an email address.</p>}
                <div className="space-y-1">
                  {contacts.map((c, i) => (
                    <Checkbox key={c.id} name="contactIds[]" value={c.id} defaultChecked={i === 0 || c.roles.includes("decision_maker")} disabled={!c.email} label={`${c.name}${c.email ? ` <${c.email}>` : " (no email)"}`} />
                  ))}
                </div>
                {fieldErrors(result, "contactIds") && <p className="field-error">{fieldErrors(result, "contactIds")?.[0]}</p>}
              </fieldset>
              {mergeTags.length > 0 && (
                <fieldset>
                  <legend className="field-label">Merge tags</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {mergeTags.map((m) => (
                      <Field key={m.tag} label={m.name} htmlFor={`mt-${m.tag}`} help={m.fallback ? `Fallback: ${m.fallback}` : undefined}>
                        <Input id={`mt-${m.tag}`} name={`mt_${m.tag}`} />
                      </Field>
                    ))}
                  </div>
                </fieldset>
              )}
              <p className="text-xs text-slate-500">Retrying this form will not create a second proposal: each version has a fixed idempotency key.</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton>Create draft</SubmitButton>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {proposals.length > 0 && (
        <Link href="/proposals" className="block text-xs text-brand-700 hover:underline">
          All proposals
        </Link>
      )}
    </div>
  );
}
