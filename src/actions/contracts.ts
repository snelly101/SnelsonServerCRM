"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import { contractLineSchema, contractSchema, linesFromForm } from "@/lib/validation-sales";
import { archiveContract, createContract, generateReminders, updateContract } from "@/services/contracts";
import { clearRenewalDecision, recordRenewalDecision } from "@/services/renewals";
import { applyPriceReview, previewPriceReview, type PriceReviewInput, type PriceReviewPreview } from "@/services/price-reviews";

function readContractForm(fd: FormData) {
  const obj = formToObject(fd);
  const input = contractSchema.parse({ ...obj, autoRenew: obj.autoRenew === "true" });
  const lines = z.array(contractLineSchema).parse(linesFromForm(obj).map((l) => ({ ...l, id: l.id || undefined, countsAsManagedDevice: l.countsAsManagedDevice === "true" })));
  const quantityEffectiveFrom = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().parse(typeof obj.quantityEffectiveFrom === "string" && obj.quantityEffectiveFrom ? obj.quantityEffectiveFrom : undefined) ?? null;
  const changeReason = z.string().trim().max(500).optional().parse(typeof obj.changeReason === "string" ? obj.changeReason : undefined) ?? null;
  return { input, lines, quantityEffectiveFrom, changeReason };
}

export async function createContractAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<string>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const { input, lines } = readContractForm(fd);
    const id = await createContract(input, lines, u.id);
    revalidatePath("/contracts");
    revalidatePath(`/companies/${input.companyId}`);
    return id;
  });
  if (res.ok) redirect(`/contracts/${res.data}`);
  return res;
}

export async function updateContractAction(id: string, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const { input, lines, quantityEffectiveFrom, changeReason } = readContractForm(fd);
    await updateContract(z.uuid().parse(id), input, lines, u.id, { quantityEffectiveFrom, changeReason });
    revalidatePath("/contracts");
    revalidatePath(`/contracts/${id}`);
    return undefined;
  });
  if (res.ok) redirect(`/contracts/${id}`);
  return res;
}

export async function archiveContractAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await archiveContract(z.uuid().parse(id), u.id);
    revalidatePath("/contracts");
    return undefined;
  });
}

export async function runRemindersAction(): Promise<ActionResult<{ created: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const res = await generateReminders(u.id);
    revalidatePath("/tasks");
    revalidatePath("/contracts");
    return res;
  });
}

export async function recordRenewalDecisionAction(id: string, input: { decision: "renew" | "amend" | "not_renewing"; note?: string | null }): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await recordRenewalDecision(z.uuid().parse(id), { decision: z.enum(["renew", "amend", "not_renewing"]).parse(input.decision), note: z.string().trim().max(1000).nullish().parse(input.note) }, u.id);
    revalidatePath("/contracts", "layout");
    revalidatePath("/billing", "layout");
    return undefined;
  });
}

export async function clearRenewalDecisionAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await clearRenewalDecision(z.uuid().parse(id), u.id);
    revalidatePath("/contracts", "layout");
    return undefined;
  });
}

const priceReviewSchema = z.object({
  scope: z.object({ productId: z.uuid().nullish(), descriptionContains: z.string().trim().max(200).nullish() }),
  change: z.object({ kind: z.enum(["percent", "unit_price", "cost_passthrough"]), value: z.coerce.number() }),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().max(500).default(""),
  lineIds: z.array(z.uuid()).max(2000).nullish(),
  updateCatalogue: z.boolean().optional(),
});

export async function previewPriceReviewAction(input: PriceReviewInput): Promise<ActionResult<PriceReviewPreview>> {
  return runAction(async () => {
    await requireActionPermission("contract.read");
    return previewPriceReview(priceReviewSchema.parse(input));
  });
}

export async function applyPriceReviewAction(input: PriceReviewInput): Promise<ActionResult<Awaited<ReturnType<typeof applyPriceReview>>>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const r = await applyPriceReview(priceReviewSchema.parse(input), u.id);
    revalidatePath("/contracts", "layout");
    revalidatePath("/billing", "layout");
    return r;
  });
}
