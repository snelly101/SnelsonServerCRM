import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { billingDiscrepancies } from "@/db/schema";
import { getAppSettings } from "@/lib/settings";
import { billingWorkspace } from "./billing-workspace";
import { reviewPendingDrafts } from "./draft-review";
import { billingFindings } from "./billing-findings";
import { renewalQueue } from "./renewals";
import { createdDraftsChangedInXero, financeTotals, xeroConnectionSummary } from "./xero";
import { lastAutomationRun } from "./billing-automation";

/**
 * The Billing overview: one screen that says where this month's billing
 * stands and what to do next, built from the same services the step pages
 * use so the numbers always agree with what those pages show.
 */
export type NextAction = { label: string; detail: string; href: string; tone: "red" | "amber" | "slate" };

export async function billingOverview(asOf = new Date().toISOString().slice(0, 10)) {
  const settings = await getAppSettings();
  const [workspace, drafts, findings, renewals, changed, totals, conn, automation, disc] = await Promise.all([
    billingWorkspace(asOf, settings.currency),
    reviewPendingDrafts(settings.currency),
    billingFindings({ asOf }),
    renewalQueue(asOf),
    createdDraftsChangedInXero(),
    financeTotals(),
    xeroConnectionSummary(),
    lastAutomationRun(),
    db.select({ status: billingDiscrepancies.status, source: billingDiscrepancies.source }).from(billingDiscrepancies).where(inArray(billingDiscrepancies.status, ["open", "accepted"])),
  ]);
  const unchanged = drafts.filter((d) => d.verdict === "unchanged").length;
  const failed = drafts.filter((d) => d.status === "failed").length;
  const stale = drafts.filter((d) => d.stale).length;
  const openDevice = disc.filter((d) => d.status === "open" && d.source === "ninjaone").length;
  const openLicence = disc.filter((d) => d.status === "open" && d.source === "pax8").length;
  const accepted = disc.filter((d) => d.status === "accepted").length;
  const renewalsOverdue = renewals.filter((r) => r.status === "overdue").length;
  const renewalsDue = renewals.filter((r) => r.status === "due").length;
  const mismatches = renewals.filter((r) => r.status !== "decided" && r.mismatches.length).length;
  const red = findings.findings.filter((f) => f.severity === "red").length;

  const next: NextAction[] = [];
  if (!conn.configured) next.push({ label: "Connect Xero", detail: "Nothing can be approved until Xero is connected.", href: "/integrations/xero", tone: "red" });
  if (workspace.summary.blocked) next.push({ label: `Link ${workspace.summary.blocked} customer${workspace.summary.blocked === 1 ? "" : "s"} to Xero`, detail: "Their drafts could be prepared but not approved.", href: "/billing/run?step=prepare", tone: "red" });
  if (failed) next.push({ label: `Fix ${failed} failed approval${failed === 1 ? "" : "s"}`, detail: "Xero did not accept the draft; the error is on the draft.", href: "/billing/run?step=approve", tone: "red" });
  if (red) next.push({ label: `Resolve ${red} red exception${red === 1 ? "" : "s"}`, detail: "Confirmed gaps before the next run: missed periods, covered services that cannot charge, invoices changed in Xero.", href: "/billing", tone: "red" });
  if (renewalsOverdue) next.push({ label: `${renewalsOverdue} renewal decision${renewalsOverdue === 1 ? "" : "s"} overdue`, detail: "Past the decision deadline; record the customer's decision or prepare an amendment.", href: "/billing/renewals", tone: "red" });
  if (workspace.summary.ready) next.push({ label: `Prepare ${workspace.summary.ready} ready contract${workspace.summary.ready === 1 ? "" : "s"}`, detail: `${new Intl.NumberFormat("en-GB", { style: "currency", currency: settings.currency }).format(workspace.summary.expected)} expected this run.`, href: "/billing/run?step=prepare", tone: "amber" });
  if (workspace.summary.review) next.push({ label: `Look at ${workspace.summary.review} contract${workspace.summary.review === 1 ? "" : "s"} needing review`, detail: "Changed amounts, open discrepancies, unmapped services or stale data.", href: "/billing/run?step=prepare", tone: "amber" });
  if (unchanged) next.push({ label: `Approve ${unchanged} unchanged draft${unchanged === 1 ? "" : "s"}`, detail: "Same lines as last time; one click creates them in Xero.", href: "/billing/run?step=approve", tone: "amber" });
  if (drafts.length - unchanged - failed > 0) next.push({ label: `Review ${drafts.length - unchanged - failed} draft exception${drafts.length - unchanged - failed === 1 ? "" : "s"}`, detail: `${stale ? `${stale} stale, ` : ""}amount or lines differ from the previous invoice.`, href: "/billing/run?step=approve", tone: "amber" });
  if (openDevice + openLicence) next.push({ label: `Resolve ${openDevice + openLicence} count discrepanc${openDevice + openLicence === 1 ? "y" : "ies"}`, detail: `${openLicence} licence, ${openDevice} device; each offers amend, reduce at renewal, bundle or exception.`, href: "/billing?group=quantities", tone: "amber" });
  if (workspace.summary.unmappedServices) next.push({ label: `Decide ${workspace.summary.unmappedServices} unmapped service${workspace.summary.unmappedServices === 1 ? "" : "s"}`, detail: "Possibly missed revenue until mapped, bundled, marked free or internal.", href: "/billing/services?state=unmapped", tone: "amber" });
  if (renewalsDue) next.push({ label: `${renewalsDue} renewal${renewalsDue === 1 ? "" : "s"} to decide now`, detail: `${mismatches ? `${mismatches} with a supplier commitment mismatch. ` : ""}Inside the decision lead time.`, href: "/billing/renewals", tone: "amber" });
  if (changed.length) next.push({ label: `${changed.length} invoice${changed.length === 1 ? "" : "s"} changed in Xero after approval`, detail: "Compare with the approved version.", href: "/billing/run?step=issued", tone: "amber" });
  if (totals.overdueCount) next.push({ label: `${totals.overdueCount} overdue invoice${totals.overdueCount === 1 ? "" : "s"} in Xero`, detail: "Chase from Xero; balances are mirrored here.", href: "/billing/invoices?overdue=1", tone: "slate" });
  if (!next.length) next.push({ label: "Nothing waiting", detail: "Every ready contract is drafted, every draft is approved and no exception is open.", href: "/billing/run", tone: "slate" });

  return {
    asOf,
    currency: settings.currency,
    conn,
    workspace: workspace.summary,
    drafts: { total: drafts.length, unchanged, exceptions: drafts.length - unchanged, failed, stale },
    findings: { total: findings.total, actionable: findings.actionable, red },
    counts: { device: openDevice, licence: openLicence, accepted },
    renewals: { overdue: renewalsOverdue, due: renewalsDue, mismatches, decided: renewals.filter((r) => r.status === "decided").length },
    xero: { outstanding: totals.outstanding, overdue: totals.overdue, overdueCount: totals.overdueCount, paidLast30: totals.paidLast30, draftsInXero: totals.draftsInXero, changed: changed.length, lastFetched: totals.lastFetched },
    automation: { level: settings.billingAutomationLevel, last: automation?.value ?? null },
    next,
  };
}
