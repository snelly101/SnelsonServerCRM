"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import { checklistTemplateSchema, linesFromForm, taskSchema } from "@/lib/validation-sales";
import { createTask, deleteTask, setTaskStatus, updateTask } from "@/services/tasks";
import { archiveTemplate, completeOnboarding, createOnboardingOnce, saveTemplate } from "@/services/onboarding";

function revalidateTaskPaths(fd?: FormData) {
  revalidatePath("/tasks");
  revalidatePath("/");
  const companyId = fd?.get("companyId");
  if (typeof companyId === "string" && companyId) revalidatePath(`/companies/${companyId}`);
  const opportunityId = fd?.get("opportunityId");
  if (typeof opportunityId === "string" && opportunityId) revalidatePath(`/pipeline/${opportunityId}`);
  const onboardingId = fd?.get("onboardingId");
  if (typeof onboardingId === "string" && onboardingId) revalidatePath(`/tasks/onboarding/${onboardingId}`);
}

export async function saveTaskAction(id: string | null, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("task.write");
    const input = taskSchema.parse(formToObject(fd));
    if (id) await updateTask(z.uuid().parse(id), input, u.id);
    else await createTask(input, u.id);
    revalidateTaskPaths(fd);
    return undefined;
  });
}

export async function setTaskStatusAction(id: string, status: "open" | "done"): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("task.write");
    await setTaskStatus(z.uuid().parse(id), status, u.id);
    revalidatePath("/tasks", "layout");
    revalidatePath("/");
    return undefined;
  });
}

export async function deleteTaskAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("task.write");
    await deleteTask(z.uuid().parse(id), u.id);
    revalidatePath("/tasks", "layout");
    return undefined;
  });
}

export async function saveTemplateAction(id: string | null, _prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    const obj = formToObject(fd);
    const items = linesFromForm(obj, "items");
    const input = checklistTemplateSchema.parse({ ...obj, isDefaultOnboarding: obj.isDefaultOnboarding === "true", items });
    await saveTemplate(input, u.id, id ?? undefined);
    revalidatePath("/tasks/templates");
    return undefined;
  });
}

export async function archiveTemplateAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("settings.write");
    await archiveTemplate(z.uuid().parse(id), u.id);
    revalidatePath("/tasks/templates");
    return undefined;
  });
}

export async function startOnboardingAction(input: { companyId: string; opportunityId?: string; templateId?: string; name: string }): Promise<ActionResult<string>> {
  return runAction(async () => {
    const u = await requireActionPermission("task.write");
    const parsed = z.object({ companyId: z.uuid(), opportunityId: z.uuid().optional(), templateId: z.uuid().optional(), name: z.string().trim().min(1).max(200) }).parse(input);
    const key = parsed.opportunityId ? `opportunity:${parsed.opportunityId}` : `manual:${parsed.companyId}:${Date.now()}`;
    const id = await createOnboardingOnce({ ...parsed, sourceKey: key, ownerUserId: u.id }, u.id);
    revalidatePath("/tasks");
    revalidatePath(`/companies/${parsed.companyId}`);
    return id;
  });
}

export async function completeOnboardingAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("task.write");
    await completeOnboarding(z.uuid().parse(id), u.id);
    revalidatePath("/tasks", "layout");
    return undefined;
  });
}
