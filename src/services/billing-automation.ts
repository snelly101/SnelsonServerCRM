import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { getAppSettings } from "@/lib/settings";
import { getSystemStatus, setSystemStatus } from "@/lib/system-status";
import { logger } from "@/lib/logger";
import { billingWorkspace } from "./billing-workspace";
import { runBillingRun } from "./billing-run";
import { approveUnchangedDrafts, reviewPendingDrafts } from "./draft-review";

/**
 * Staged billing automation (brief section 9): the monthly billing run moves
 * from detect-only to prepared drafts to approved unchanged drafts only when
 * a policy in Settings says so. Every step uses the same deterministic rules
 * a person would (the workspace's "ready" status, the review's "unchanged"
 * verdict) and is audited as a system action naming the policy. Nothing is
 * ever authorised or sent from Xero.
 *
 *   0  Detect only (default): findings, workspace and review are prepared for
 *      people; nothing is created.
 *   1  Prepare drafts for ready contracts on the run day of each month.
 *   2  As 1, then approve (create in Xero as DRAFT) the drafts the review finds
 *      unchanged. Exceptions stay for a person.
 */
export const AUTOMATION_LEVELS: { level: number; label: string; detail: string }[] = [
  { level: 0, label: "Detect only", detail: "The billing run, findings and draft review are prepared for people to act on. Nothing is created automatically." },
  { level: 1, label: "Prepare ready drafts", detail: "On the run day each month, drafts are prepared for contracts the workspace rates ready (Xero linked, same amount as last time, nothing open). Review and approval stay with finance." },
  { level: 2, label: "Prepare, then approve unchanged drafts", detail: "As above, then drafts the review finds unchanged (same lines as the previous invoice, not stale, Xero linked) are created in Xero as drafts. Exceptions wait for a person. Nothing is authorised or sent by the CRM." },
];

export const STATUS_KEY = "billing.automation.lastRun";

export type AutomationRunResult = {
  level: number;
  asOf: string;
  trigger: "schedule" | "manual";
  ran: boolean;
  reason: string | null;
  prepared: { draftId: string; companyName: string; contractName: string; net: number }[];
  preparedSkipped: { contractName: string; reason: string }[];
  approved: { id: string; reference: string; companyName: string }[];
  approvalSkipped: { id: string; reference: string; companyName: string; reason: string }[];
  readyContracts: number;
  reviewContracts: number;
  blockedContracts: number;
};

const monthOf = (iso: string) => iso.slice(0, 7);

/**
 * Runs the policy for `asOf`. A scheduled run happens once per month, on or
 * after the run day; a manual run (from Settings) always runs. Level 0 never
 * creates anything but still records what it would have done.
 */
export async function runBillingAutomation(opts: { asOf?: string; trigger: "schedule" | "manual"; actorUserId?: string | null } = { trigger: "schedule" }): Promise<AutomationRunResult> {
  const settings = await getAppSettings();
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const level = settings.billingAutomationLevel;
  const base: AutomationRunResult = { level, asOf, trigger: opts.trigger, ran: false, reason: null, prepared: [], preparedSkipped: [], approved: [], approvalSkipped: [], readyContracts: 0, reviewContracts: 0, blockedContracts: 0 };
  if (opts.trigger === "schedule") {
    const day = Number(asOf.slice(8, 10));
    if (day < settings.billingAutomationDay) return { ...base, reason: `Run day is the ${settings.billingAutomationDay}; today is the ${day}` };
    // Once a month: a run that could create something (level 1 or 2) counts; detect-only runs never block a later policy.
    const last = await getSystemStatus<{ asOf: string; level?: number; ran?: boolean }>(STATUS_KEY);
    if (last && last.value.ran !== false && (last.value.level ?? 0) >= 1 && monthOf(last.value.asOf) === monthOf(asOf)) return { ...base, reason: `Already ran this month on ${last.value.asOf}` };
  }
  const actor = opts.actorUserId ?? null;
  const { rows, summary } = await billingWorkspace(asOf, settings.currency);
  base.readyContracts = summary.ready;
  base.reviewContracts = summary.review;
  base.blockedContracts = summary.blocked;
  if (level === 0) {
    const result = { ...base, ran: true, reason: "Detect only: nothing created" };
    await finish(result, actor);
    return result;
  }
  const ready = rows.filter((r) => r.status === "ready").map((r) => r.contractId);
  if (ready.length) {
    const run = await runBillingRun(asOf, ready, actor, { consolidate: settings.billingAutomationConsolidate });
    base.prepared = run.created.map((c) => ({ draftId: c.draftId, companyName: c.companyName, contractName: c.contractName, net: c.net }));
    base.preparedSkipped = run.skipped.map((s) => ({ contractName: s.contractName, reason: s.reason }));
  }
  if (level >= 2) {
    const review = await reviewPendingDrafts(settings.currency);
    const unchanged = review.filter((d) => d.verdict === "unchanged").map((d) => d.id);
    if (unchanged.length) {
      const r = await approveUnchangedDrafts(unchanged, actor, settings.currency);
      base.approved = r.approved.map((a) => ({ id: a.id, reference: a.reference, companyName: a.companyName }));
      base.approvalSkipped = r.skipped;
    }
  }
  const result = { ...base, ran: true };
  await finish(result, actor);
  return result;
}

async function finish(result: AutomationRunResult, actorUserId: string | null) {
  await setSystemStatus(STATUS_KEY, { asOf: result.asOf, at: new Date().toISOString(), ran: result.ran, level: result.level, trigger: result.trigger, prepared: result.prepared.length, approved: result.approved.length, approvalSkipped: result.approvalSkipped.length, ready: result.readyContracts, review: result.reviewContracts, blocked: result.blockedContracts, reason: result.reason });
  await audit({ actorUserId, actorType: actorUserId ? "user" : "system", action: "billing.automation.run", entityType: "app_settings", entityId: "1", details: { policy: `level ${result.level}`, trigger: result.trigger, asOf: result.asOf, prepared: result.prepared.map((p) => p.draftId), approved: result.approved.map((a) => a.id), approvalSkipped: result.approvalSkipped.length, ready: result.readyContracts, review: result.reviewContracts, blocked: result.blockedContracts } });
  logger.info({ level: result.level, trigger: result.trigger, asOf: result.asOf, prepared: result.prepared.length, approved: result.approved.length }, "billing automation run");
}

export async function lastAutomationRun() {
  return getSystemStatus<{ asOf: string; at: string; level: number; trigger: string; prepared: number; approved: number; approvalSkipped: number; ready: number; review: number; blocked: number; reason: string | null }>(STATUS_KEY);
}

export function describeLevel(level: number) {
  const l = AUTOMATION_LEVELS.find((x) => x.level === level);
  if (!l) throw new ActionError("Unknown automation level.");
  return l;
}
