"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import { lineSchema, linesFromForm, opportunitySchema, productSchema, stageSchema } from "@/lib/validation-sales";
import { archiveOpportunity, archiveStage, createOpportunity, createStage, markLost, markWon, moveOpportunity, reopenOpportunity, reorderStages, updateOpportunity, updateStage } from "@/services/opportunities";
import { createProduct, updateProduct } from "@/services/catalogue";
import { draftContractFromOpportunity } from "@/services/contracts";
import { validateCustomFields } from "@/services/settings";

function readOpportunityForm(fd: FormData) {
  const obj = formToObject(fd);
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k.startsWith("cf_")) customFields[k.slice(3)] = v;
  const input = opportunitySchema.parse({ ...obj, customFields });
  const lines = z.array(lineSchema).parse(linesFromForm(obj));
  return { input, lines };
}

export async function createOpportunityAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<string>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("opportunity.write");
    const { input, lines } = readOpportunityForm(fd);
    input.customFields = await validateCustomFields("opportunity", input.customFields);
    const id = await createOpportunity(input, lines, u.id);
    revalidatePath("/pipeline");
    revalidatePath(`/companies/${input.companyId}`);
    return id;
  });
  if (res.ok) redirect(`/pipeline/${res.data}`);
  return res;
}

export async function updateOpportunityAction(id: string, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("opportunity.write");
    const { input, lines } = readOpportunityForm(fd);
    input.customFields = await validateCustomFields("opportunity", input.customFields);
    await updateOpportunity(z.uuid().parse(id), input, lines, u.id);
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${id}`);
    return undefined;
  });
  if (res.ok) redirect(`/pipeline/${id}`);
  return res;
}

export async function moveOpportunityAction(id: string, stageId: string, position: number): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("opportunity.write");
    await moveOpportunity(z.uuid().parse(id), z.uuid().parse(stageId), z.number().int().min(0).parse(position), u.id);
    revalidatePath("/pipeline");
    return undefined;
  });
}

export async function markWonAction(id: string, opts: { createOnboarding: boolean; draftContract: boolean }): Promise<ActionResult<{ onboardingId: string | null; contractId: string | null }>> {
  return runAction(async () => {
    const u = await requireActionPermission("opportunity.write");
    z.uuid().parse(id);
    const { onboardingId } = await markWon(id, u.id, { createOnboarding: opts.createOnboarding });
    const contractId = opts.draftContract ? await draftContractFromOpportunity(id, u.id) : null;
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${id}`);
    revalidatePath("/tasks");
    revalidatePath("/contracts");
    return { onboardingId, contractId };
  });
}

export async function markLostAction(id: string, reason: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("opportunity.write");
    await markLost(z.uuid().parse(id), z.string().trim().min(1, "Give a reason").max(500).parse(reason), u.id);
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${id}`);
    return undefined;
  });
}

export async function reopenOpportunityAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("opportunity.write");
    await reopenOpportunity(z.uuid().parse(id), u.id);
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${id}`);
    return undefined;
  });
}

export async function archiveOpportunityAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("opportunity.delete");
    await archiveOpportunity(z.uuid().parse(id), u.id);
    revalidatePath("/pipeline");
    return undefined;
  });
}

// ---- Stages (admin) ----
export async function saveStageAction(id: string | null, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    const input = stageSchema.parse(formToObject(fd));
    if (id) await updateStage(z.uuid().parse(id), input, u.id);
    else await createStage(input, u.id);
    revalidatePath("/settings/pipeline");
    revalidatePath("/pipeline");
    return undefined;
  });
}

export async function reorderStagesAction(ids: string[]): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    await reorderStages(z.array(z.uuid()).parse(ids), u.id);
    revalidatePath("/settings/pipeline");
    revalidatePath("/pipeline");
    return undefined;
  });
}

export async function archiveStageAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    await archiveStage(z.uuid().parse(id), u.id);
    revalidatePath("/settings/pipeline");
    revalidatePath("/pipeline");
    return undefined;
  });
}

// ---- Catalogue ----
export async function saveProductAction(id: string | null, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("catalogue.write");
    const obj = formToObject(fd);
    const input = productSchema.parse({ ...obj, countsAsManagedDevice: obj.countsAsManagedDevice === "true", active: obj.active === undefined ? true : obj.active === "true" });
    if (id) await updateProduct(z.uuid().parse(id), input, u.id);
    else await createProduct(input, u.id);
    revalidatePath("/contracts/catalogue");
    return undefined;
  });
}
