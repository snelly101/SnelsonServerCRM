"use client";

import Link from "next/link";
import { Fragment, useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { clearServiceCoverageAction, setServiceCoverageAction, setServiceLineAction } from "@/actions/coverage";
import { useToast } from "@/components/ui/toast";
import { confident, suggestLines } from "@/lib/service-suggest";
import { MatchServiceDialog, type CatalogueOption, type ContractOption } from "@/components/billing/match-service";
import { fmtDate, fmtMoney, fmtRelative, type DisplaySettings } from "@/lib/format";
import type { RegisterRow } from "@/services/service-register";
import { MATCH_SOURCE_LABELS, SERVICE_STATE_LABELS, type ServiceState } from "@/lib/billing-model";

export const STATE_TONE: Record<ServiceState, string> = {
  charged: "green",
  bundle: "teal",
  commitment: "blue",
  free: "amber",
  internal: "slate",
  investigate: "red",
  unmapped: "amber",
};

export type LineOption = { id: string; description: string; contractName: string; contractStatus: string; contractId?: string; productSku?: string | null; productName?: string | null };

/**
 * The "not charged separately" decisions for one service: bundled into a
 * line, covered by a commitment, intentionally free, internal, or flagged
 * for investigation. Used inside the coverage dialog and as a tab of the
 * matching dialog.
 */
export function CoverageForm({ row, lines, onDone }: { row: RegisterRow; lines: LineOption[]; onDone: () => void }) {
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
                  onDone();
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
                onDone();
                router.refresh();
              })
            }
          >
            Save
          </Button>
        </span>
      </div>
    </div>
  );
}

/** One row's coverage control: opens a small dialog to record why a service is, or is not, charged. */
export function CoverageDialog({ row, lines, trigger }: { row: RegisterRow; lines: LineOption[]; trigger?: string }) {
  const [open, setOpen] = useState(false);
  const explicit = row.state !== "charged" && row.state !== "unmapped";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={row.state === "unmapped" ? "secondary" : "ghost"} onClick={() => setOpen(true)}>
        {trigger ?? (explicit ? "Change" : row.state === "unmapped" ? "Decide" : "Not charged separately?")}
      </Button>
      <DialogContent title={`${row.name}`} description={`${row.kind}${row.companyName ? ` · ${row.companyName}` : ""}. Say how this service is covered commercially so it stops reading as unmapped, or mark it for investigation.`}>
        <CoverageForm row={row} lines={lines} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

type MatchingProps = { contractsByCompany: Record<string, ContractOption[]>; products: CatalogueOption[]; currency: string };

/**
 * The register as a table. With `matching` and write permission every row
 * gets the matching dialog and, where a line looks right, a one-click
 * "charge on …" button. With `showCompany` the rows are grouped under a
 * heading per customer so a whole customer can be worked through in place.
 */
export function ServiceRegisterTable({ rows, linesByCompany, canEdit, settings, showCompany, matching }: { rows: RegisterRow[]; linesByCompany: Record<string, LineOption[]>; canEdit: boolean; settings: DisplaySettings & { currency: string }; showCompany: boolean; matching?: MatchingProps }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-slate-500">No services to show.</p>;
  const groups: { companyId: string; companyName: string | null; rows: RegisterRow[] }[] = [];
  for (const r of rows) {
    const g = showCompany ? groups.find((x) => x.companyId === r.companyId) : groups[0];
    if (g) g.rows.push(r);
    else groups.push({ companyId: r.companyId, companyName: r.companyName, rows: [r] });
  }
  const cols = 7 + (canEdit ? 1 : 0);
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Service</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Cost / mo</th>
            <th>Renews</th>
            <th>Synced</th>
            <th>State</th>
            <th>Billed on</th>
            {canEdit && <th className="text-right">Match</th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.companyId}>
              {showCompany && (
                <tr className="bg-slate-50/80">
                  <td colSpan={cols} className="py-1.5">
                    <span className="flex flex-wrap items-center gap-2 text-[13px]">
                      <Link href={`/companies/${g.companyId}?tab=billing`} className="font-semibold text-slate-900 hover:underline">
                        {g.companyName ?? "—"}
                      </Link>
                      <span className="text-xs text-slate-500">
                        {g.rows.length} service{g.rows.length === 1 ? "" : "s"}
                        {(linesByCompany[g.companyId]?.length ?? 0) === 0 && matching ? " · no agreement lines yet" : ""}
                      </span>
                    </span>
                  </td>
                </tr>
              )}
              {g.rows.map((r) => (
                <RegisterRowView key={r.key} r={r} lines={linesByCompany[r.companyId] ?? []} canEdit={canEdit} settings={settings} matching={matching} />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegisterRowView({ r, lines, canEdit, settings, matching }: { r: RegisterRow; lines: LineOption[]; canEdit: boolean; settings: DisplaySettings & { currency: string }; matching?: MatchingProps }) {
  const top = canEdit && matching && !r.pool && (r.state === "unmapped" || r.state === "investigate") ? suggestLines(r, lines)[0] : undefined;
  const topLine = confident(top) ? lines.find((l) => l.id === top!.lineId) : undefined;
  return (
    <tr className={r.state === "unmapped" ? "bg-amber-50/40" : r.state === "investigate" ? "bg-red-50/40" : ""}>
      <td>
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={r.provider === "pax8" ? "indigo" : r.provider === "twentyi" ? "teal" : "blue"}>{r.providerLabel}</Badge>
          <Link href={r.href} className="font-medium hover:underline">
            {r.name}
          </Link>
        </div>
        <div className="text-xs text-slate-500">
          {r.kind}
          {r.supplierProduct ? ` · ${r.supplierProduct}` : r.detail ? ` · ${r.detail}` : ""}
        </div>
      </td>
      <td className="text-right tabular-nums">{r.quantity ?? "—"}</td>
      <td className="text-right tabular-nums">{r.monthlyCost === null ? <span className="text-slate-400" title={r.costKnown ? "no recurring price" : "the supplier carries no pricing"}>{r.costKnown ? "—" : "not reported"}</span> : fmtMoney(r.monthlyCost, settings.currency)}</td>
      <td className="whitespace-nowrap text-xs">{r.renewsOn ? fmtDate(r.renewsOn, settings) : "—"}</td>
      <td className="whitespace-nowrap text-xs text-slate-500">{r.syncedAt ? fmtRelative(r.syncedAt) : "—"}</td>
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
        {r.matchedBy && (r.state === "charged" || r.state === "bundle") && <div className="text-[11px] text-slate-400">{MATCH_SOURCE_LABELS[r.matchedBy]}</div>}
        {r.reason && <div className="text-slate-500">{r.reason}</div>}
        {r.setByName && <div className="text-[11px] text-slate-400">by {r.setByName}</div>}
      </td>
      {canEdit && (
        <td className="text-right">
          {r.pool ? (
            <span className="text-xs text-slate-500">tick “Compare with NinjaOne” on a per-device line</span>
          ) : matching ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-1">
              {topLine && <SuggestedButton row={r} line={topLine} reason={top!.reason} />}
              <MatchServiceDialog row={r} lines={lines} contracts={matching.contractsByCompany[r.companyId] ?? []} products={matching.products} currency={matching.currency} />
            </span>
          ) : (
            <CoverageDialog row={r} lines={lines} />
          )}
        </td>
      )}
    </tr>
  );
}

/** One click charges the service on the line the suggestion picked. */
function SuggestedButton({ row, line, reason }: { row: RegisterRow; line: LineOption; reason: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={pending}
      title={`Suggested: ${reason}`}
      className="max-w-[16rem] text-brand-700"
      onClick={() =>
        start(async () => {
          const r = await setServiceLineAction(row.source, row.rowId, line.id);
          if (!r.ok) return toast(r.error, "error");
          toast(`${row.name} charged on ${line.description}; counts re-checked`);
          router.refresh();
        })
      }
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{line.description}</span>
    </Button>
  );
}

/** Links each state pill to the register filtered to it; `baseQuery` carries the other filters (provider, customer, search). */
export function RegisterSummaryBar({ summary, current, baseQuery }: { summary: Record<string, number>; current?: string; baseQuery?: string }) {
  const hrefFor = baseQuery === undefined ? undefined : (state: string) => {
    const u = new URLSearchParams(baseQuery);
    if (state !== "decide") u.set("state", state);
    else u.delete("state");
    const qs = u.toString();
    return `/billing/services${qs ? `?${qs}` : ""}`;
  };
  const order: ServiceState[] = ["unmapped", "investigate", "charged", "bundle", "commitment", "free", "internal"];
  const pill = (k: string, label: React.ReactNode, tone: string, n: number) => {
    const cls = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${current === k ? "border-slate-900 bg-selection text-selection-fg" : "border-slate-200 hover:bg-slate-50"}`;
    const body = (
      <>
        <Badge tone={tone}>{n}</Badge> {label}
      </>
    );
    return hrefFor ? (
      <Link key={k} href={hrefFor(k)} className={cls}>
        {body}
      </Link>
    ) : (
      <span key={k} className={cls}>
        {body}
      </span>
    );
  };
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {hrefFor && pill("decide", "To decide", "amber", (summary.unmapped ?? 0) + (summary.investigate ?? 0) + (summary.reviewOverdue ?? 0))}
      {hrefFor && pill("all", "Everything", "slate", summary.total ?? 0)}
      {order.map((k) => pill(k, SERVICE_STATE_LABELS[k], STATE_TONE[k], summary[k] ?? 0))}
      {summary.reviewOverdue > 0 && pill("review", "review overdue", "red", summary.reviewOverdue)}
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
