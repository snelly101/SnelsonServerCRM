"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import { checklistAddSchema } from "@/lib/validation-helpdesk";
import {
  addChecklistItems,
  deleteChecklistItem,
  renderTemplate,
  toggleChecklistItem,
  updateChecklistItem,
} from "@/services/helpdesk-collab";
import { markNotificationsRead } from "@/services/helpdesk-notifications";

const revalidate = (ticketId?: string) => {
  revalidatePath("/helpdesk", "layout");
  if (ticketId) revalidatePath(`/helpdesk/tickets/${ticketId}`);
};

export async function addChecklistAction(
  ticketId: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ ids: string[] }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const input = checklistAddSchema.parse(formToObject(fd));
    const ids = await addChecklistItems(
      z.uuid().parse(ticketId),
      input.items,
      { id: u.id, type: "user" },
      { assigneeUserId: input.assigneeUserId, dueDate: input.dueDate },
    );
    revalidate(ticketId);
    return { ids };
  });
}
export async function toggleChecklistAction(
  ticketId: string,
  itemId: string,
  done: boolean,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await toggleChecklistItem(z.uuid().parse(ticketId), z.uuid().parse(itemId), done, {
      id: u.id,
      type: "user",
    });
    revalidate(ticketId);
    return undefined;
  });
}
export async function updateChecklistAction(
  ticketId: string,
  itemId: string,
  patch: { title?: string; assigneeUserId?: string | null; dueDate?: string | null },
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const clean = z
      .object({
        title: z.string().trim().min(1).max(300).optional(),
        assigneeUserId: z.string().nullable().optional(),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      })
      .parse(patch);
    await updateChecklistItem(z.uuid().parse(ticketId), z.uuid().parse(itemId), clean, {
      id: u.id,
      type: "user",
    });
    revalidate(ticketId);
    return undefined;
  });
}
export async function deleteChecklistAction(
  ticketId: string,
  itemId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await deleteChecklistItem(z.uuid().parse(ticketId), z.uuid().parse(itemId), {
      id: u.id,
      type: "user",
    });
    revalidate(ticketId);
    return undefined;
  });
}

/** Fills a template's placeholders for one ticket so the composer can insert it. */
export async function renderTemplateAction(
  ticketId: string,
  body: string,
): Promise<ActionResult<{ body: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const text = await renderTemplate(
      z.string().max(20_000).parse(body),
      z.uuid().parse(ticketId),
      u.id,
    );
    return { body: text };
  });
}

export async function markNotificationsReadAction(
  ids: string[] | "all",
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.read");
    await markNotificationsRead(
      u.id,
      ids === "all" ? "all" : z.array(z.uuid()).max(200).parse(ids),
    );
    revalidatePath("/helpdesk", "layout");
    return undefined;
  });
}
