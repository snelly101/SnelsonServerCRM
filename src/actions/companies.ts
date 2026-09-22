"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { companySchema, formToObject, noteSchema, siteSchema } from "@/lib/validation";
import { archiveCompany, createCompany, findDuplicateCompanies, updateCompany } from "@/services/companies";
import { archiveSite, upsertSite } from "@/services/contacts";
import { validateCustomFields } from "@/services/settings";
import { logActivity } from "@/lib/audit";

function readCompanyForm(fd: FormData) {
  const obj = formToObject(fd);
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("cf_")) customFields[k.slice(3)] = v;
  }
  const tagIds = obj.tagIds ? (Array.isArray(obj.tagIds) ? obj.tagIds : [obj.tagIds]) : [];
  return companySchema.parse({ ...obj, tagIds, customFields });
}

export async function createCompanyAction(_prev: ActionResult<string> | null, fd: FormData): Promise<ActionResult<string>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("company.write");
    const input = readCompanyForm(fd);
    input.customFields = await validateCustomFields("company", input.customFields);
    const force = fd.get("confirmDuplicate") === "true";
    const id = await createCompany(input, u.id, { skipDuplicateCheck: force });
    revalidatePath("/companies");
    return id;
  });
  if (res.ok) redirect(`/companies/${res.data}`);
  return res;
}

export async function updateCompanyAction(id: string, _prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("company.write");
    z.uuid().parse(id);
    const input = readCompanyForm(fd);
    input.customFields = await validateCustomFields("company", input.customFields);
    await updateCompany(id, input, u.id);
    revalidatePath(`/companies/${id}`);
    revalidatePath("/companies");
    return undefined;
  });
  if (res.ok) redirect(`/companies/${id}`);
  return res;
}

export async function archiveCompanyAction(id: string, restore = false): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.delete");
    z.uuid().parse(id);
    await archiveCompany(id, u.id, restore);
    revalidatePath(`/companies/${id}`);
    revalidatePath("/companies");
    return undefined;
  });
}

export async function checkDuplicatesAction(input: { name: string; website?: string; email?: string; companyNumber?: string; vatNumber?: string; excludeId?: string }) {
  return runAction(async () => {
    await requireActionPermission("company.read");
    if (!input.name?.trim()) return [];
    return findDuplicateCompanies(input, input.excludeId);
  });
}

export async function saveSiteAction(siteId: string | null, _prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const input = siteSchema.parse(formToObject(fd));
    await upsertSite(input, u.id, siteId ?? undefined);
    revalidatePath(`/companies/${input.companyId}`);
    return undefined;
  });
}

export async function archiveSiteAction(siteId: string, companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    await archiveSite(z.uuid().parse(siteId), u.id);
    revalidatePath(`/companies/${companyId}`);
    return undefined;
  });
}

export async function addNoteAction(_prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.write");
    const input = noteSchema.parse(formToObject(fd));
    await logActivity({
      type: input.type,
      companyId: input.companyId,
      contactId: input.contactId,
      title: input.title,
      body: input.body,
      actorUserId: u.id,
    });
    revalidatePath(`/companies/${input.companyId}`);
    return undefined;
  });
}
