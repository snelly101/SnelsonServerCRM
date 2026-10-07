"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { clearServiceCoverageAction, setServiceCoverageAction } from "@/actions/coverage";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";
import type { RegisterRow } from "@/services/service-register";
import { SERVICE_STATE_LABELS, type ServiceState } from "@/lib/service-coverage";

export const STATE_TONE: Record<ServiceState, string> = {
  charged: "green",
  bundle: "teal",
  commitment: "blue",
  free: "amber",
  internal: "slate",
  investigate: "red",
  unmapped: "amber",
};

type LineOption = { id: string; description: string; contractName: string; contractStatus: string };

/** One row's coverage control: opens a small dialog to record why a service is, or is not, charged. */
export function CoverageDialog({ row, lines, trigger }: { row: RegisterRow; lines: LineOption[]; trigger?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<string>(row.state === "charged" || row.state === "unmapped" ? "bundle" : row.state);
  const [lineId, setLineId] = useState<string>(row.line?.id ?? "");
  const [reason, setReason] = useState(row.reason ?? "");
  const [reviewOn, setReviewOn] = useState(row.reviewOn ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const isDevice = row.source === "ninja_device";
  const needsLine = state === "bundle" || state === "commitment";
  const needsReason = state === "free" || state === "internal" || state === "investigate";
  const options: ServiceState[] = isDevice ? ["internal", "free", "investigate"] : ["bundle", "commitment", "free", "internal", "investigate"];
  const explicit = row.state !== "charged" && row.state !== "unmapped";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={row.state === "unmapped" ? "secondary" : "ghost"} onClick={() => setOpen(true)}>
        {trigger ?? (explicit ? "Change" : row.state === "unmapped" ? "Decide" : "Not charged separately?")}
      </Button>
      <DialogContent title={`${row.name}`} description={`${row.kind}${row.companyName ? ` · ${row.companyName}` : ""}. Say how this service is covered commercially so it stops reading as unmapped, or mark it for investigation.`}>
        <div className="space-y-3">
          <Field label="Coverage" htmlFor={`cov-${row.key}`}>
            <Select id={`cov-${row.key}`} value={state} onChange={(e) => setState(e.target.value)}>
              {options.map((o) => (
                <option key={o} value={o}>
                  {SERVICE_STATE_LABELS[o]}
                </option>
              ))}
            </Select>
          </Field>
          {needsLine && (
            <Field label={state === "bundle" ? "Included in contract line" : "Commitment line (optional)"} htmlFor={`cov-line-${row.key}`} help={state === "bundle" ? "Its quantity counts toward this line in the licence check." : "The minimum-commitment line that pays for it; nothing is counted against it."}>
              <Select id={`cov-line-${row.key}`} value={lineId} onChange={(e) => setLineId(e.target.value)}>
                <option value="">— choose —</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.description}
                    {l.contractStatus === "draft" ? " (draft)" : ""} · {l.contractName}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={needsReason ? "Reason" : "Note (optional)"} htmlFor={`cov-reason-${row.key}`} help="What the next person needs to know.">
            <Textarea id={`cov-reason-${row.key}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={state === "free" ? "e.g. goodwill after the March outage, agreed by Ryan" : state === "internal" ? "e.g. our own test tenant" : ""} />
          </Field>
          {(state === "free" || state === "investigate") && (
            <Field label={state === "free" ? "Review on" : "Review on (optional)"} htmlFor={`cov-review-${row.key}`} help={state === "free" ? "Free arrangements are looked at again on this date; the register flags it when it passes." : undefined}>
              <Input id={`cov-review-${row.key}`} type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} className="w-44" />
            </Field>
          )}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <span>
              {explicit && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await clearServiceCoverageAction(row.source, row.rowId, row.companyId);
                      if (!r.ok) return setError(r.error);
                      setOpen(false);
                      router.refresh();
                    })
                  }
                >
                  Clear (back to the billing line)
                </Button>
              )}
            </span>
            <span className="flex gap-2">
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await setServiceCoverageAction({ source: row.source, sourceRowId: row.rowId, state, contractLineId: needsLine ? lineId || null : null, reason, reviewOn: reviewOn || null });
                    if (!r.ok) return setError(r.error);
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                Save
              </Button>
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ServiceRegisterTable({ rows, linesByCompany, canEdit, settings, showCompany }: { rows: RegisterRow[]; linesByCompany: Record<string, LineOption[]>; canEdit: boolean; settings: DisplaySettings & { currency: string }; showCompany: boolean }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">No services to show.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            {showCompany && <th>Company</th>}
            <th>Service</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Cost / mo</th>
            <th>Renews</th>
            <th>Coverage</th>
            <th>Covered by</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.state === "unmapped" ? "bg-amber-50/40" : r.state === "investigate" ? "bg-red-50/40" : ""}>
              {showCompany && (
                <td>
                  <Link href={`/companies/${r.companyId}`} className="hover:underline">
                    {r.companyName}
                  </Link>
                </td>
              )}
              <td>
                <Link href={r.href} className="font-medium hover:underline">
                  {r.name}
                </Link>
                <div className="text-xs text-slate-500">
                  {r.kind}
                  {r.detail ? ` · ${r.detail}` : ""}
                </div>
              </td>
              <td className="text-right tabular-nums">{r.quantity ?? "—"}</td>
              <td className="text-right tabular-nums">{r.monthlyCost === null ? "—" : fmtMoney(r.monthlyCost, settings.currency)}</td>
              <td className="whitespace-nowrap text-xs">{r.renewsOn ? fmtDate(r.renewsOn, settings) : "—"}</td>
              <td>
                <Badge tone={STATE_TONE[r.state]}>{SERVICE_STATE_LABELS[r.state]}</Badge>
                {r.reviewOn && (
                  <div className={`text-[11px] ${r.reviewOverdue ? "text-red-700" : "text-slate-500"}`}>
                    review {fmtDate(r.reviewOn, settings)}
                    {r.reviewOverdue ? " · overdue" : ""}
                  </div>
                )}
              </td>
              <td className="text-xs">
                {r.line ? (
                  <>
                    {r.line.description} <span className="text-slate-500">({r.line.contractName})</span>
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
                {r.reason && <div className="text-slate-500">{r.reason}</div>}
                {r.setByName && <div className="text-[11px] text-slate-400">by {r.setByName}</div>}
              </td>
              {canEdit && <td className="text-right">{r.pool ? null : <CoverageDialog row={r} lines={linesByCompany[r.companyId] ?? []} />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RegisterSummaryBar({ summary }: { summary: Record<string, number> }) {
  const order: ServiceState[] = ["unmapped", "investigate", "charged", "bundle", "commitment", "free", "internal"];
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {order.map((k) => (
        <span key={k} className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5">
          <Badge tone={STATE_TONE[k]}>{summary[k] ?? 0}</Badge> {SERVICE_STATE_LABELS[k]}
        </span>
      ))}
      {summary.reviewOverdue > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-200 px-2 py-0.5 text-red-700">
          <Badge tone="red">{summary.reviewOverdue}</Badge> review overdue
        </span>
      )}
    </div>
  );
}

/** Per-device coverage on the company Devices tab: mark a device internal or free, or flag it. */
export function DeviceCoverageControl({ device }: { device: { id: string; companyId: string; name: string; nodeClass: string; coverage: { state: string; reason: string | null; reviewOn: string | null } | null } }) {
  const row: RegisterRow = {
    key: `ninja_device:${device.id}`,
    source: "ninja_device",
    rowId: device.id,
    provider: "ninjaone",
    providerLabel: "NinjaOne",
    companyId: device.companyId,
    companyName: null,
    kind: "Device",
    name: device.name,
    supplierProduct: device.nodeClass,
    detail: device.nodeClass.toLowerCase().replace(/_/g, " "),
    quantity: 1,
    monthlyCost: null,
    costKnown: false,
    renewsOn: null,
    status: "active",
    syncedAt: null,
    consoleUrl: null,
    pool: false,
    matchedBy: null,
    linkedAt: null,
    state: (device.coverage?.state as ServiceState | undefined) ?? "charged",
    line: null,
    reason: device.coverage?.reason ?? null,
    reviewOn: device.coverage?.reviewOn ?? null,
    reviewOverdue: false,
    setByName: null,
    href: "",
  };
  return (
    <span className="inline-flex items-center gap-1">
      {device.coverage && <Badge tone={STATE_TONE[row.state]}>{SERVICE_STATE_LABELS[row.state]}</Badge>}
      <CoverageDialog row={row} lines={[]} trigger={device.coverage ? "Change" : "Billable?"} />
    </span>
  );
}
