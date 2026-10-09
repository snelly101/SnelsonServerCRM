"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { invitePortalAccount, resetPortalTotp, setPortalAccess } from "@/services/portal";

export async function invitePortalAction(contactId: string, isCompanyAdmin: boolean): Promise<ActionResult<{ link: string; emailed: boolean; expiresAt: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const r = await invitePortalAccount(z.uuid().parse(contactId), { isCompanyAdmin }, u.id);
    revalidatePath(`/contacts/${contactId}`, "page");
    return { link: r.link, emailed: r.emailed, expiresAt: r.expiresAt.toISOString() };
  });
}

export async function setPortalAccessAction(contactId: string, patch: { enabled?: boolean; isCompanyAdmin?: boolean }): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await setPortalAccess(z.uuid().parse(contactId), z.object({ enabled: z.boolean().optional(), isCompanyAdmin: z.boolean().optional() }).parse(patch), u.id);
    revalidatePath(`/contacts/${contactId}`, "page");
    return undefined;
  });
}

export async function resetPortalTotpAction(contactId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await resetPortalTotp(z.uuid().parse(contactId), u.id);
    revalidatePath(`/contacts/${contactId}`, "page");
    return undefined;
  });
}
