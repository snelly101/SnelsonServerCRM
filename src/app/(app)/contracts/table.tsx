"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Archive, ArchiveRestore, Check, CheckSquare, ChevronDown, Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { bulkArchiveContractsAction, quickUpdateContractsAction } from "@/actions/contracts";
import { CONTRACT_STATUS_LABELS, contractStatusValues, FREQUENCY_LABELS, type ContractQuickPatch } from "@/lib/validation-sales";
import { fmtDate, fmtMoney, type DisplaySettings } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ContractTableRow = {
  id: string;
  name: string;
  reference: string | null;
  status: string;
  companyId: string;
  companyName: string;
  mrr: number;
  billingFrequency: string;
  startDate: string;
  renewalDate: string | null;
  noticeDeadline: string | null;
  nextReviewDate: string | null;
};

export const STATUS_TONE: Record<string, string> = { draft: "slate", active: "green", expired: "amber", cancelled: "red" };

type DateField = "startDate" | "renewalDate" | "nextReviewDate";
type BulkAction = "status" | "startDate" | "endDate" | "renewalDate" | "nextReviewDate" | "noticePeriodDays" | "owner" | "archive";
const BULK_LABELS: Record<BulkAction, string> = {
  status: "Set status",
  startDate: "Set start date",
  endDate: "Set end date",
  renewalDate: "Set renewal date",
  nextReviewDate: "Set next review",
  noticePeriodDays: "Set notice period",
  owner: "Set owner",
  archive: "Archive",
};

/**
 * The contracts list. With write permission every row can be changed where
 * it sits: the status badge opens a menu, the Start, Renewal and Next review
 * cells turn into a date picker on click, and the contract name opens the
 * full edit form. Ticking rows reveals a bar that applies one change (a
 * status, a date, the owner, archive) to the whole selection.
 */
export function ContractTable({ rows, canWrite, settings, owners, archived }: { rows: ContractTableRow[]; canWrite: boolean; settings: DisplaySettings; owners: { id: string; name: string }[]; archived: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<BulkAction>("status");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const c = settings.currency;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** One change for one row; the toast names the contract so the list can refresh underneath. */
  const patchOne = (row: ContractTableRow, patch: ContractQuickPatch, label: string) =>
    start(async () => {
      const r = await quickUpdateContractsAction({ ids: [row.id], patch });
      if (r.ok) toast(`${row.name}: ${label}`);
      else toast(r.error, "error");
      router.refresh();
    });

  const applyBulk = () =>
    start(async () => {
      const ids = [...selected];
      const r = action === "archive" ? await bulkArchiveContractsAction(ids, archived) : await quickUpdateContractsAction({ ids, patch: bulkPatch(action, value) });
      if (r.ok) {
        const unchanged = "unchanged" in r.data && r.data.unchanged ? `, ${r.data.unchanged} already so` : "";
        setMsg(`${r.data.done} ${action === "archive" ? (archived ? "restored" : "archived") : "updated"}${unchanged}${r.data.errors.length ? `; ${r.data.errors.join(" · ")}` : ""}`);
        setSelected(new Set());
        setValue("");
      } else setMsg(r.error);
      router.refresh();
    });

  const needsValue = action !== "archive" && !(action === "owner" || action === "endDate" || action === "renewalDate" || action === "nextReviewDate");
  const dateCell = (row: ContractTableRow, field: DateField, className?: string) =>
    canWrite ? <DateCell value={row[field]} required={field === "startDate"} settings={settings} disabled={pending} className={className} onCommit={(v) => patchOne(row, { [field]: v } as ContractQuickPatch, v ? `${DATE_LABELS[field]} set to ${fmtDate(v, settings)}` : `${DATE_LABELS[field]} cleared`)} /> : <span className={className}>{fmtDate(row[field], settings)}</span>;

  return (
    <div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-sm">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded border-slate-300" />
            {selected.size ? `${selected.size} selected` : "Select"}
          </label>
          {selected.size > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              <Select
                aria-label="Bulk action"
                className="h-8 w-auto text-xs"
                value={action}
                onChange={(e) => {
                  setAction(e.target.value as BulkAction);
                  setValue("");
                }}
              >
                {(Object.keys(BULK_LABELS) as BulkAction[]).map((a) => (
                  <option key={a} value={a}>
                    {a === "archive" && archived ? "Restore" : BULK_LABELS[a]}
                  </option>
                ))}
              </Select>
              {action === "status" && (
                <Select aria-label="New status" className="h-8 w-auto text-xs" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">— choose —</option>
                  {contractStatusValues.map((s) => (
                    <option key={s} value={s}>
                      {CONTRACT_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
              {(action === "startDate" || action === "endDate" || action === "renewalDate" || action === "nextReviewDate") && <Input type="date" aria-label="New date" className="h-8 w-auto text-xs" value={value} onChange={(e) => setValue(e.target.value)} />}
              {action === "noticePeriodDays" && <Input type="number" min={0} max={730} aria-label="Notice period in days" placeholder="days" className="h-8 w-24 text-xs" value={value} onChange={(e) => setValue(e.target.value)} />}
              {action === "owner" && (
                <Select aria-label="New owner" className="h-8 w-auto text-xs" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">— no owner —</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button size="sm" variant={action === "archive" && !archived ? "danger-outline" : "secondary"} loading={pending} disabled={needsValue && !value} onClick={applyBulk}>
                {action === "archive" ? archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />} Apply to {selected.size}
              </Button>
              {(action === "endDate" || action === "renewalDate" || action === "nextReviewDate") && !value && <span className="text-xs text-slate-500">Leave the date empty to clear it.</span>}
            </span>
          ) : (
            <span className="text-xs text-slate-500">Tick rows to change several at once. Click a status or a date to change it in place.</span>
          )}
          {msg && <span className="text-xs text-slate-600">{msg}</span>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              {canWrite && <th className="w-8" />}
              <th>Contract</th>
              <th>Company</th>
              <th>Status</th>
              <th className="text-right" title="Normalised: annual ÷ 12, quarterly ÷ 3">
                MRR
              </th>
              <th>Billing</th>
              <th>Start</th>
              <th>Renewal</th>
              <th title="Renewal date less the notice period">Notice by</th>
              <th>Next review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? "bg-brand-50/40" : undefined}>
                {canWrite && (
                  <td>
                    <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 rounded border-slate-300" />
                  </td>
                )}
                <td>
                  <div className="flex items-center gap-1.5">
                    <Link href={canWrite ? `/contracts/${r.id}/edit` : `/contracts/${r.id}`} className="font-medium link" title={canWrite ? "Edit this contract" : undefined}>
                      {r.name}
                    </Link>
                    {canWrite && (
                      <>
                        <Pencil className="h-3 w-3 text-slate-400" aria-hidden />
                        <Link href={`/contracts/${r.id}`} className="pill-icon h-6 w-6 text-slate-400" title="Open the contract overview" aria-label={`Open ${r.name}`}>
                          <Eye className="h-3.5 w-3.5" />
                        </Link>
                      </>
                    )}
                  </div>
                  {r.reference && <div className="text-xs text-slate-500">{r.reference}</div>}
                </td>
                <td>
                  <Link href={`/companies/${r.companyId}`} className="hover:underline">
                    {r.companyName}
                  </Link>
                </td>
                <td>{canWrite ? <StatusMenu row={r} disabled={pending} onPick={(s) => patchOne(r, { status: s }, `${CONTRACT_STATUS_LABELS[r.status as keyof typeof CONTRACT_STATUS_LABELS] ?? r.status} → ${CONTRACT_STATUS_LABELS[s]}`)} /> : <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>}</td>
                <td className="text-right tabular-nums">{fmtMoney(r.mrr, c)}</td>
                <td>{FREQUENCY_LABELS[r.billingFrequency as keyof typeof FREQUENCY_LABELS] ?? r.billingFrequency}</td>
                <td>{dateCell(r, "startDate")}</td>
                <td>{dateCell(r, "renewalDate")}</td>
                <td className={r.noticeDeadline && r.noticeDeadline <= today && r.status === "active" ? "font-medium text-red-600" : ""}>{fmtDate(r.noticeDeadline, settings)}</td>
                <td>{dateCell(r, "nextReviewDate", r.nextReviewDate && r.nextReviewDate < today ? "text-amber-700" : undefined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const DATE_LABELS: Record<DateField, string> = { startDate: "Start", renewalDate: "Renewal", nextReviewDate: "Next review" };

function bulkPatch(action: Exclude<BulkAction, "archive">, value: string): ContractQuickPatch {
  switch (action) {
    case "status":
      return { status: value as ContractQuickPatch["status"] };
    case "startDate":
      return { startDate: value };
    case "endDate":
      return { endDate: value || null };
    case "renewalDate":
      return { renewalDate: value || null };
    case "nextReviewDate":
      return { nextReviewDate: value || null };
    case "noticePeriodDays":
      return { noticePeriodDays: Number(value) };
    case "owner":
      return { ownerUserId: value || null };
  }
}

/** The status badge as a menu: pick a status and the row is updated in place. */
function StatusMenu({ row, disabled, onPick }: { row: ContractTableRow; disabled: boolean; onPick: (s: (typeof contractStatusValues)[number]) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button type="button" className="group inline-flex items-center gap-0.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30" aria-label={`Change status of ${row.name} (currently ${row.status})`} title="Change status">
          <Badge tone={STATUS_TONE[row.status]} className="group-hover:brightness-95">
            {row.status}
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
          </Badge>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="menu">
          {contractStatusValues.map((s) => (
            <DropdownMenu.Item key={s} className="menu-item justify-between" disabled={s === row.status} onSelect={() => s !== row.status && onPick(s)}>
              <span className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", { draft: "bg-slate-400", active: "bg-green-500", expired: "bg-amber-500", cancelled: "bg-red-500" }[s])} aria-hidden />
                {CONTRACT_STATUS_LABELS[s]}
              </span>
              {s === row.status && <Check className="h-3.5 w-3.5 text-slate-400" aria-hidden />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * A date shown as text that becomes a date picker on click. Enter or leaving
 * the field saves when the value changed; Escape puts the old value back.
 * Optional dates can be cleared by emptying the field.
 */
function DateCell({ value, required, settings, disabled, className, onCommit }: { value: string | null; required: boolean; settings: DisplaySettings; disabled: boolean; className?: string; onCommit: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const open = () => {
    setDraft(value ?? "");
    closed.current = false;
    setEditing(true);
  };
  const commit = () => {
    // Enter commits and unmounts the input, which can fire its blur as well; save once.
    if (closed.current) return;
    closed.current = true;
    setEditing(false);
    const next = draft || null;
    if (next === (value ?? null)) return;
    if (!next && required) return;
    onCommit(next);
  };
  if (!editing)
    return (
      <button type="button" onClick={open} disabled={disabled} className={cn("-mx-1.5 rounded-md px-1.5 py-0.5 text-left tabular-nums hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-500/30 outline-none", className)} title="Click to change">
        {fmtDate(value, settings)}
      </button>
    );
  return (
    <input
      ref={ref}
      type="date"
      value={draft}
      required={required}
      aria-label="Date"
      className="input h-8 w-36 py-0 text-xs"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closed.current = true;
          setDraft(value ?? "");
          setEditing(false);
        }
      }}
    />
  );
}
