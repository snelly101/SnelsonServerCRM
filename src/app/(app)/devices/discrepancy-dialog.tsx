"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { discrepancyOptionsAction, previewDiscrepancyResolutionAction, resolveDiscrepancyAction } from "@/actions/ninjaone";
import type { DiscrepancyImpact } from "@/lib/discrepancy-impact";

type Options = Extract<Awaited<ReturnType<typeof discrepancyOptionsAction>>, { ok: true }>["data"];
type Kind = Options["kinds"][number];

const KIND_LABEL: Record<Kind, string> = {
  amend_line: "Amend the contract line to the observed count",
  reduce_at_renewal: "Reduce at renewal (bill the agreed count until then)",
  include_in_bundle: "Include subscriptions in a bundle line",
  exception: "Accept as an exception for now (owner and review date)",
  dismiss: "Dismiss: not a billing matter",
};

const money = (n: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);

/** Opens the resolution dialog for one discrepancy: the concrete actions, each with its money consequence before it is taken. */
export function ResolveDiscrepancyButton({ id, currency, kindLabel }: { id: string; currency: string; kindLabel: "device" | "licence" }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("amend_line");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [bundleLineId, setBundleLineId] = useState("");
  const [subs, setSubs] = useState<Set<string>>(new Set());
  const [ownerUserId, setOwnerUserId] = useState("");
  const [reviewOn, setReviewOn] = useState("");
  const [impact, setImpact] = useState<DiscrepancyImpact | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open || opts) return;
    start(async () => {
      const r = await discrepancyOptionsAction(id);
      if (!r.ok) return setError(r.error);
      setOpts(r.data);
      setEffectiveFrom(r.data.effectiveFrom);
      setImpact(r.data.impact.amend_line);
      const inThreeMonths = new Date(Date.now() + 91 * 86400000).toISOString().slice(0, 10);
      setReviewOn(inThreeMonths);
      setSubs(new Set(r.data.subscriptions.map((s) => s.id)));
    });
  }, [open, opts, id]);

  const choose = (k: Kind) => {
    setKind(k);
    setError(null);
    if (!opts) return;
    if (k === "amend_line" || k === "reduce_at_renewal" || k === "exception") setImpact(opts.impact[k] ?? null);
    else setImpact(null);
  };
  const changeDate = (d: string) => {
    setEffectiveFrom(d);
    if (!opts || !/^\d{4}-\d{2}-\d{2}$/.test(d) || (kind !== "amend_line" && kind !== "reduce_at_renewal")) return;
    start(async () => {
      const r = await previewDiscrepancyResolutionAction(id, kind, d);
      if (r.ok) setImpact(r.data);
    });
  };
  const submit = () =>
    start(async () => {
      const r = await resolveDiscrepancyAction(id, { kind, effectiveFrom, reason, bundleLineId: bundleLineId || null, subscriptionRowIds: [...subs], ownerUserId: ownerUserId || null, reviewOn: reviewOn || null });
      if (!r.ok) return setError(r.error);
      setOpen(false);
      router.refresh();
    });

  const diff = opts?.difference ?? 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" title="Decide what to do about this difference and see the money consequence first">
          <Wrench className="h-3.5 w-3.5" /> Resolve…
        </Button>
      </DialogTrigger>
      <DialogContent title={`Resolve ${kindLabel} discrepancy`} description={opts ? `${opts.lineDescription}: contracted ${opts.contracted}, observed ${opts.observed} (${diff > 0 ? "+" : ""}${diff}). ${opts.contract.name}.` : "Loading…"} wide>
        {error && <Alert tone="error" className="mb-3">{error}</Alert>}
        {opts && (
          <div className="space-y-4">
            <fieldset className="space-y-1.5">
              <legend className="field-label">What to do</legend>
              {opts.kinds.map((k) => (
                <label key={k} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="radio" name="kind" className="mt-1" checked={kind === k} onChange={() => choose(k)} />
                  <span>{KIND_LABEL[k]}</span>
                </label>
              ))}
            </fieldset>

            {(kind === "amend_line" || kind === "reduce_at_renewal") && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Effective from" htmlFor="effectiveFrom" help={`${opts.line.description}: ${opts.line.quantity} → ${opts.line.newQuantity}`}>
                  <Input id="effectiveFrom" type="date" value={effectiveFrom} onChange={(e) => changeDate(e.target.value)} />
                </Field>
                <Field label="Reason" htmlFor="reason" help="Goes into the change history and the activity timeline">
                  <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`${kindLabel} count agreed with the customer`} />
                </Field>
              </div>
            )}

            {kind === "include_in_bundle" && (
              <div className="space-y-3">
                <Field label="Bundle line" htmlFor="bundleLine" help="The line on this contract that already pays for these subscriptions">
                  <Select id="bundleLine" value={bundleLineId} onChange={(e) => setBundleLineId(e.target.value)}>
                    <option value="">Choose a line…</option>
                    {opts.bundleLines.map((l) => (
                      <option key={l.id} value={l.id}>{l.description} (qty {l.quantity})</option>
                    ))}
                  </Select>
                </Field>
                <fieldset className="space-y-1">
                  <legend className="field-label">Subscriptions to include</legend>
                  {opts.subscriptions.length === 0 && <p className="text-xs text-slate-500">No subscriptions recorded on this discrepancy; re-run the licence check first.</p>}
                  {opts.subscriptions.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={subs.has(s.id)} onChange={(e) => setSubs((cur) => { const n = new Set(cur); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
                      <span>{s.productName} <span className="text-xs text-slate-500">× {s.quantity} · {s.subscriptionId}</span></span>
                    </label>
                  ))}
                </fieldset>
                <Field label="Reason" htmlFor="bundleReason">
                  <Input id="bundleReason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Covered by the bundle price" />
                </Field>
              </div>
            )}

            {kind === "exception" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Owner" htmlFor="owner" required help="Who follows this up">
                  <Select id="owner" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
                    <option value="">Choose…</option>
                    {opts.users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Review on" htmlFor="reviewOn" required help="The item re-opens by itself after this date">
                  <Input id="reviewOn" type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} />
                </Field>
                <Field label="Why it is accepted for now" htmlFor="exceptionReason" required className="sm:col-span-2">
                  <Textarea id="exceptionReason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer leaving in March, agreed not to amend" />
                </Field>
              </div>
            )}

            {kind === "dismiss" && (
              <Field label="Note" htmlFor="dismissNote">
                <Input id="dismissNote" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this is not a billing matter" />
              </Field>
            )}

            {impact && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <p className="font-medium text-slate-800">Money consequence</p>
                {kind === "exception" ? (
                  <p className="text-slate-700">{impact.note}.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-700">
                    <li>This period: <span className="tabular-nums font-medium">{impact.thisPeriod > 0 ? "+" : ""}{money(impact.thisPeriod, currency)}</span></li>
                    <li>Every period after: <span className="tabular-nums font-medium">{impact.perPeriod > 0 ? "+" : ""}{money(impact.perPeriod, currency)}</span>{impact.from && <span className="text-slate-500"> from {impact.from}</span>}</li>
                    <li className="text-xs text-slate-500">{impact.note}.</li>
                  </ul>
                )}
              </div>
            )}
            {kind === "include_in_bundle" && <p className="text-xs text-slate-500">The chosen subscriptions stop counting against this line and count toward the bundle line instead; the licence check runs again straight away and this item closes if the counts then match.</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="button" onClick={submit} loading={pending}>
                {kind === "dismiss" ? "Dismiss" : kind === "exception" ? "Accept until review date" : "Apply"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
