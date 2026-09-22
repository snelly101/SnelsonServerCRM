"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { moveOpportunityAction } from "@/actions/sales";
import type { OpportunityRow } from "@/services/opportunities";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

type Column = { stage: { id: string; name: string; color: string; probability: number }; items: OpportunityRow[]; total: number; weighted: number };

const COLOR: Record<string, string> = {
  slate: "border-slate-400",
  blue: "border-blue-500",
  indigo: "border-indigo-500",
  amber: "border-amber-500",
  green: "border-green-500",
  red: "border-red-500",
  teal: "border-teal-500",
  purple: "border-purple-500",
  pink: "border-pink-500",
  orange: "border-orange-500",
};

/**
 * Kanban board using native HTML5 drag and drop (no library). The move is
 * applied optimistically, then confirmed by the server action; on failure the
 * board reverts and shows the error.
 */
export function Board({ columns, canWrite, currency }: { columns: Column[]; canWrite: boolean; currency: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ stageId: string; index: number } | null>(null);
  const [optimistic, applyMove] = useOptimistic(columns, (state, move: { id: string; toStage: string; index: number }) => {
    let moved: OpportunityRow | undefined;
    const without = state.map((c) => ({ ...c, items: c.items.filter((i) => (i.id === move.id ? ((moved = i), false) : true)) }));
    if (!moved) return state;
    return without.map((c) => {
      if (c.stage.id !== move.toStage) return recalc(c);
      const items = [...c.items];
      items.splice(Math.min(move.index, items.length), 0, { ...moved!, stageId: c.stage.id, probability: c.stage.probability });
      return recalc({ ...c, items });
    });
  });

  const onDrop = (stageId: string, index: number) => {
    if (!dragging || !canWrite) return;
    const id = dragging;
    setDragging(null);
    setOver(null);
    start(async () => {
      applyMove({ id, toStage: stageId, index });
      const res = await moveOpportunityAction(id, stageId, index);
      if (!res.ok) setError(res.error);
      else setError(null);
      router.refresh();
    });
  };

  return (
    <div>
      {error && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className={cn("flex gap-3 overflow-x-auto pb-4", pending && "opacity-80")}>
        {optimistic.map((col) => (
          <section
            key={col.stage.id}
            aria-label={col.stage.name}
            className={cn("flex w-72 shrink-0 flex-col rounded-lg border-t-4 bg-slate-100/70", COLOR[col.stage.color] ?? COLOR.slate, over?.stageId === col.stage.id && "ring-2 ring-brand-300")}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              if (over?.stageId !== col.stage.id || over.index !== col.items.length) setOver({ stageId: col.stage.id, index: col.items.length });
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(col.stage.id, over?.stageId === col.stage.id ? over.index : col.items.length);
            }}
          >
            <header className="px-3 pb-1 pt-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">{col.stage.name}</h2>
                <span className="rounded-full bg-white px-2 text-xs text-slate-600">{col.items.length}</span>
              </div>
              <div className="text-xs text-slate-500">
                {fmtMoney(col.total, currency)} · weighted {fmtMoney(col.weighted, currency)}
              </div>
            </header>
            <ul className="flex min-h-[80px] flex-1 flex-col gap-2 p-2">
              {col.items.map((o, idx) => (
                <li
                  key={o.id}
                  draggable={canWrite}
                  onDragStart={(e) => {
                    setDragging(o.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragging || dragging === o.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const before = e.clientY < rect.top + rect.height / 2;
                    const index = before ? idx : idx + 1;
                    if (over?.stageId !== col.stage.id || over.index !== index) setOver({ stageId: col.stage.id, index });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDrop(col.stage.id, over?.index ?? idx);
                  }}
                  className={cn("rounded-md border border-slate-200 bg-white p-2.5 shadow-sm", canWrite && "cursor-grab active:cursor-grabbing", dragging === o.id && "opacity-40", over?.stageId === col.stage.id && over.index === idx && "border-t-2 border-t-brand-500")}
                >
                  <Link href={`/pipeline/${o.id}`} className="block text-sm font-medium text-slate-900 hover:text-brand-700" draggable={false}>
                    {o.title}
                  </Link>
                  <div className="truncate text-xs text-slate-500">{o.companyName}</div>
                  <div className="mt-1.5 flex items-center justify-between text-xs">
                    <span className="font-medium tabular-nums text-slate-800">{fmtMoney(o.summary.firstYearValue, currency)}</span>
                    <span className="text-slate-500">{o.probability}%</span>
                  </div>
                  {o.summary.mrr > 0 && <div className="text-[11px] text-green-700">MRR {fmtMoney(o.summary.mrr, currency)}</div>}
                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
                    {o.ownerName && <span className="truncate">{o.ownerName.split(" ")[0]}</span>}
                    {o.expectedCloseDate && (
                      <span className={cn("inline-flex items-center gap-0.5", o.expectedCloseDate < new Date().toISOString().slice(0, 10) && "text-red-600")}>
                        <CalendarClock className="h-3 w-3" /> {o.expectedCloseDate}
                      </span>
                    )}
                    {o.overdueTasks > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-red-600" title={`${o.overdueTasks} overdue task(s)`}>
                        <AlertTriangle className="h-3 w-3" /> {o.overdueTasks}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function recalc(c: Column): Column {
  return { ...c, total: c.items.reduce((a, i) => a + i.summary.firstYearValue, 0), weighted: c.items.reduce((a, i) => a + (i.summary.firstYearValue * i.probability) / 100, 0) };
}
