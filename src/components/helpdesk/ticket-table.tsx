"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Columns3, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import { SortLink } from "@/components/ui/pagination";
import { StatusBadge, PriorityBadge, TypeBadge, dueLabel } from "./badges";
import { bulkTicketAction } from "@/actions/helpdesk";
import {
  DEFAULT_TICKET_COLUMNS,
  TICKET_COLUMN_LABELS,
  TICKET_COLUMNS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketColumn,
} from "@/lib/validation-helpdesk";
import { fmtRelative } from "@/lib/format";

export type TicketRow = {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  type: string;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterUnverified: boolean;
  companyId: string | null;
  companyName: string | null;
  assigneeName: string | null;
  teamName: string | null;
  categoryName: string | null;
  needsReview: boolean;
  firstResponseAt: Date | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  timeSpentMinutes: number;
  tags: string[];
};

const minutes = (n: number) =>
  n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`;

export function TicketTable({
  rows,
  canManage,
  columns,
  agents,
  teams,
}: {
  rows: TicketRow[];
  canManage: boolean;
  columns: TicketColumn[];
  agents: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<
    "assign" | "team" | "priority" | "status"
  >("assign");
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [chooser, setChooser] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const apply = () =>
    start(async () => {
      const r = await bulkTicketAction({ ids: [...selected], action, value });
      setMsg(
        r.ok
          ? `${r.data.done} updated${r.data.errors.length ? `; ${r.data.errors.join(" · ")}` : ""}`
          : r.error,
      );
      if (r.ok) setSelected(new Set());
      router.refresh();
    });
  const setColumns = (cols: TicketColumn[]) => {
    const next = new URLSearchParams(sp.toString());
    if (cols.join(",") === DEFAULT_TICKET_COLUMNS.join(","))
      next.delete("cols");
    else next.set("cols", cols.join(","));
    router.replace(`${pathname}?${next.toString()}`);
  };
  const has = (c: TicketColumn) => columns.includes(c);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-sm">
        {canManage && (
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              aria-label="Select all on this page"
              checked={allSelected}
              onChange={toggleAll}
              className="h-4 w-4 rounded border-slate-300"
            />
            {selected.size ? `${selected.size} selected` : "Select"}
          </label>
        )}
        {canManage && selected.size > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            <Select
              aria-label="Bulk action"
              className="h-8 w-auto text-xs"
              value={action}
              onChange={(e) => {
                setAction(e.target.value as typeof action);
                setValue("");
              }}
            >
              <option value="assign">Assign to</option>
              <option value="team">Team</option>
              <option value="priority">Priority</option>
              <option value="status">Status</option>
            </Select>
            <Select
              aria-label="Bulk value"
              className="h-8 w-auto text-xs"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="">
                {action === "assign"
                  ? "— unassigned —"
                  : action === "team"
                    ? "— no team —"
                    : "— choose —"}
              </option>
              {action === "assign" &&
                agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              {action === "team" &&
                teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              {action === "priority" &&
                TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TICKET_PRIORITY_LABELS[p]}
                  </option>
                ))}
              {action === "status" &&
                TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_STATUS_LABELS[s]}
                  </option>
                ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              loading={pending}
              disabled={
                (action === "priority" || action === "status") && !value
              }
              onClick={apply}
            >
              <CheckSquare className="h-3.5 w-3.5" /> Apply to {selected.size}
            </Button>
          </span>
        )}
        {msg && <span className="text-xs text-slate-600">{msg}</span>}
        <span className="relative ml-auto">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setChooser((c) => !c)}
            aria-expanded={chooser}
            aria-haspopup="true"
          >
            <Columns3 className="h-3.5 w-3.5" /> Columns
          </Button>
          {chooser && (
            <div
              className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-slate-200 bg-surface p-2 shadow-lg"
              role="group"
              aria-label="Choose columns"
            >
              {TICKET_COLUMNS.map((c) => (
                <label
                  key={c}
                  className="flex items-center gap-2 px-1 py-0.5 text-xs"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={has(c)}
                    disabled={c === "reference" || c === "subject"}
                    onChange={(e) =>
                      setColumns(
                        e.target.checked
                          ? TICKET_COLUMNS.filter((x) => x === c || has(x))
                          : columns.filter((x) => x !== c),
                      )
                    }
                  />
                  {TICKET_COLUMN_LABELS[c]}
                </label>
              ))}
              <button
                type="button"
                className="mt-1 w-full rounded px-1 py-0.5 text-left text-xs text-brand-700 hover:bg-slate-100"
                onClick={() => setColumns(DEFAULT_TICKET_COLUMNS)}
              >
                Reset to default
              </button>
            </div>
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              {canManage && <th className="w-8" />}
              {has("reference") && (
                <th>
                  <SortLink column="reference" label="Ref" />
                </th>
              )}
              {has("subject") && (
                <th>
                  <SortLink column="subject" label="Subject" />
                </th>
              )}
              {has("status") && (
                <th>
                  <SortLink column="status" label="Status" />
                </th>
              )}
              {has("priority") && (
                <th>
                  <SortLink column="priority" label="Priority" />
                </th>
              )}
              {has("type") && <th>Type</th>}
              {has("requester") && (
                <th>
                  <SortLink column="requester" label="Requester" />
                </th>
              )}
              {has("company") && (
                <th>
                  <SortLink column="company" label="Company" />
                </th>
              )}
              {has("assignee") && (
                <th>
                  <SortLink column="assignee" label="Assignee" />
                </th>
              )}
              {has("team") && <th>Team</th>}
              {has("category") && <th>Category</th>}
              {has("due") && (
                <th>
                  <SortLink column="due" label="Due" />
                </th>
              )}
              {has("time") && <th className="text-right">Time</th>}
              {has("updated") && (
                <th>
                  <SortLink column="updated" label="Updated" />
                </th>
              )}
              {has("created") && (
                <th>
                  <SortLink column="created" label="Created" />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="py-8 text-center text-sm text-slate-500"
                >
                  No tickets match.
                </td>
              </tr>
            )}
            {rows.map((t) => {
              const due = dueLabel(
                t.firstResponseAt ? t.resolutionDueAt : t.firstResponseDueAt,
                false,
              );
              return (
                <tr
                  key={t.id}
                  className={selected.has(t.id) ? "bg-brand-50/40" : ""}
                >
                  {canManage && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${t.reference}`}
                        checked={selected.has(t.id)}
                        onChange={() => toggle(t.id)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </td>
                  )}
                  {has("reference") && (
                    <td className="whitespace-nowrap font-mono text-xs">
                      <Link
                        href={`/helpdesk/tickets/${t.id}`}
                        className="text-slate-600 hover:underline"
                      >
                        {t.reference}
                      </Link>
                    </td>
                  )}
                  {has("subject") && (
                    <td className="min-w-[260px] max-w-[520px]">
                      <Link
                        href={`/helpdesk/tickets/${t.id}`}
                        className="font-medium text-slate-800 hover:text-brand-700 [overflow-wrap:anywhere]"
                      >
                        {t.subject}
                      </Link>
                      <span className="ml-1 inline-flex gap-1 align-middle">
                        {t.needsReview && <Badge tone="amber">review</Badge>}
                        {t.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} tone="slate">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  )}
                  {has("status") && (
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                  )}
                  {has("priority") && (
                    <td>
                      <PriorityBadge priority={t.priority} />
                    </td>
                  )}
                  {has("type") && (
                    <td>
                      <TypeBadge type={t.type} />
                    </td>
                  )}
                  {has("requester") && (
                    <td className="text-xs">
                      <div>
                        {t.requesterName ?? t.requesterEmail ?? "—"}
                        {t.requesterUnverified && (
                          <Badge className="ml-1" tone="amber">
                            unverified
                          </Badge>
                        )}
                      </div>
                      {t.requesterName && t.requesterEmail && (
                        <div className="text-slate-500">{t.requesterEmail}</div>
                      )}
                    </td>
                  )}
                  {has("company") && (
                    <td className="text-xs">
                      {t.companyId ? (
                        <Link
                          href={`/companies/${t.companyId}?tab=tickets`}
                          className="text-brand-700 hover:underline"
                        >
                          {t.companyName}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  )}
                  {has("assignee") && (
                    <td className="text-xs">
                      {t.assigneeName ?? (
                        <span className="text-amber-700">unassigned</span>
                      )}
                    </td>
                  )}
                  {has("team") && (
                    <td className="text-xs">{t.teamName ?? "—"}</td>
                  )}
                  {has("category") && (
                    <td className="text-xs">{t.categoryName ?? "—"}</td>
                  )}
                  {has("due") && (
                    <td className="text-xs">
                      {due ? (
                        <Badge tone={due.tone}>{due.text}</Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  )}
                  {has("time") && (
                    <td className="text-right text-xs tabular-nums">
                      {t.timeSpentMinutes ? minutes(t.timeSpentMinutes) : "—"}
                    </td>
                  )}
                  {has("updated") && (
                    <td
                      className="whitespace-nowrap text-xs text-slate-500"
                      title={new Date(t.lastActivityAt).toISOString()}
                    >
                      {fmtRelative(t.lastActivityAt)}
                    </td>
                  )}
                  {has("created") && (
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {fmtRelative(t.createdAt)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
