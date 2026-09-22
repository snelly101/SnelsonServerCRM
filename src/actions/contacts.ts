"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { contactSchema, formToObject } from "@/lib/validation";
import { archiveContact, createContact, updateContact } from "@/services/contacts";
import { validateCustomFields } from "@/services/settings";

function readContactForm(fd: FormData) {
  const obj = formToObject(fd);
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (k.startsWith("cf_")) customFields[k.slice(3)] = v;
  const roles = obj.roles ? (Array.isArray(obj.roles) ? obj.roles : [obj.roles]) : [];
  return contactSchema.parse({ ...obj, roles, customFields });
}

export async function createContactAction(_prev: ActionResult<string> | null, fd: FormData): Promise<ActionResult<string>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("contact.write");
    const input = readContactForm(fd);
    input.customFields = await validateCustomFields("contact", input.customFields);
    const id = await createContact(input, u.id);
    revalidatePath("/contacts");
    revalidatePath(`/companies/${input.companyId}`);
    return id;
  });
  if (res.ok) {
    const returnTo = fd.get("returnTo");
    redirect(typeof returnTo === "string" && returnTo.startsWith("/") ? returnTo : `/contacts/${res.data}`);
  }
  return res;
}

export async function updateContactAction(id: string, _prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  const res = await runAction(async () => {
    const u = await requireActionPermission("contact.write");
    z.uuid().parse(id);
    const input = readContactForm(fd);
    input.customFields = await validateCustomFields("contact", input.customFields);
    await updateContact(id, input, u.id);
    revalidatePath(`/contacts/${id}`);
    revalidatePath("/contacts");
    revalidatePath(`/companies/${input.companyId}`);
    return undefined;
  });
  if (res.ok) redirect(`/contacts/${id}`);
  return res;
}

export async function archiveContactAction(id: string, companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contact.delete");
    await archiveContact(z.uuid().parse(id), u.id);
    revalidatePath("/contacts");
    revalidatePath(`/companies/${companyId}`);
    return undefined;
  });
}
