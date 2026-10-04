import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { contracts, type InvoiceDraftLine } from "@/db/schema";
import { customerExplanation } from "@/lib/customer-explanation";
import { fmtDate, type DisplaySettings } from "@/lib/format";
import { serviceRegisterRows } from "./service-register";

/**
 * Everything the customer schedule page shows for a draft: plain-language
 * summary, lines grouped by agreement with service dates, the services behind
 * each charge from the register, and renewal information.
 */
export type ScheduleLine = { name: string; note: string | null; from: string | null; to: string | null; quantity: number; unitAmount: number; amount: number };

export async function customerSchedule(draft: { companyId: string; contractId: string | null; contractIds: string[] | null; currencyCode: string; lines: InvoiceDraftLine[] }, settings: DisplaySettings & { currency: string }) {
  const money = (n: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: draft.currencyCode }).format(n);
  const explanation = customerExplanation(draft.lines, { money, date: (iso) => fmtDate(iso, settings) });
  const ids = draft.contractId ? [draft.contractId] : (draft.contractIds ?? []);
  const agreements = ids.length ? await db.select({ id: contracts.id, name: contracts.name, renewalDate: contracts.renewalDate, noticePeriodDays: contracts.noticePeriodDays, autoRenew: contracts.autoRenew, status: contracts.status }).from(contracts).where(and(inArray(contracts.id, ids), isNull(contracts.archivedAt))) : [];
  const nameOf = new Map(agreements.map((a) => [a.id, a.name]));
  // Lines are grouped by the agreement prefix a consolidated draft gives them ("Agreement · line"); single-agreement drafts form one group.
  const groups = new Map<string, { key: string; title: string; lines: ScheduleLine[] }>();
  for (const l of draft.lines) {
    const split = ids.length > 1 ? l.description.split(" · ") : [l.description];
    const title = split.length > 1 ? split[0] : (nameOf.get(ids[0]) ?? "Charges");
    const rest = split.length > 1 ? split.slice(1).join(" · ") : l.description;
    const c = l.calc;
    const name = rest.replace(/\s*\((?:\d{4}-\d{2}-\d{2}|\d{1,2} \w+ \d{4}).*$/, "").replace(/:\s.*$/, "").trim() || rest;
    const note = c?.kind === "increase" ? `added ${fmtDate(c.from, settings)}, ${c.days} of ${c.fullDays} days` : c?.kind === "decrease" ? `removed ${fmtDate(c.from, settings)}, credit for ${c.days} days` : c?.kind === "prorata" ? `${c.days} of ${c.fullDays} days` : c?.kind === "catchup" ? "adjustment for an earlier period" : null;
    const g = groups.get(title) ?? { key: title, title, lines: [] };
    g.lines.push({ name, note, from: c?.from ?? null, to: c?.to ?? null, quantity: l.quantity, unitAmount: l.unitAmount, amount: Math.round(l.quantity * l.unitAmount * 100) / 100 });
    groups.set(title, g);
  }
  // Supporting schedule: the services the register ties to each charged line.
  const lineIds = [...new Set(draft.lines.map((l) => l.contractLineId).filter((x): x is string => Boolean(x)))];
  const register = lineIds.length ? await serviceRegisterRows([draft.companyId]) : [];
  const supporting = lineIds
    .map((lineId) => {
      const items = register.filter((r) => r.line?.id === lineId && r.state !== "unmapped").map((r) => ({ key: r.key, name: r.name, quantity: r.quantity, detail: r.kind === "Managed devices" ? null : r.detail }));
      const line = draft.lines.find((l) => l.contractLineId === lineId)!;
      return { lineId, name: line.description.replace(/\s*\((?:\d{4}-\d{2}-\d{2}|\d{1,2} \w+ \d{4}).*$/, "").replace(/:\s.*$/, "").replace(/^.* · /, ""), items };
    })
    .filter((s) => s.items.length);
  return {
    summary: explanation.summary,
    from: explanation.from,
    to: explanation.to,
    groups: [...groups.values()],
    supporting,
    renewals: agreements.filter((a) => a.renewalDate && a.status === "active").map((a) => ({ contractId: a.id, name: a.name, renewalDate: a.renewalDate!, noticeDeadline: a.renewalDate ? new Date(Date.parse(a.renewalDate) - a.noticePeriodDays * 86400000).toISOString().slice(0, 10) : null, autoRenew: a.autoRenew })),
  };
}
