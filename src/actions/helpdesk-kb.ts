"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { runAction, ActionError, type ActionResult } from "@/lib/action-result";
import { formToObject } from "@/lib/validation";
import {
  articleBodyForInsert,
  deleteArticle,
  linkArticleToTicket,
  restoreRevision,
  saveArticle,
  setArticleStatus,
  unlinkArticleFromTicket,
} from "@/services/helpdesk-kb";
import { linkDevice, unlinkDevice } from "@/services/helpdesk-assets";
import { anonymiseByEmail, anonymiseTicket } from "@/services/helpdesk-retention";

const revalidate = (ticketId?: string) => {
  revalidatePath("/helpdesk", "layout");
  if (ticketId) revalidatePath(`/helpdesk/tickets/${ticketId}`);
};

const articleSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  body: z.string().max(100_000).default(""),
  summary: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  category: z
    .string()
    .trim()
    .max(80)
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (Array.isArray(v) ? v : (v ?? "").split(/[,\n]/)).map((t) => t.trim()).filter(Boolean)),
  customerVisible: z.coerce.boolean().default(false),
  reviewDueAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? new Date(`${v}T00:00:00Z`) : null)),
  changeNote: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  fromTicketId: z
    .string()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
});

export async function saveArticleAction(
  id: string | null,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const input = articleSchema.parse({
      ...formToObject(fd),
      customerVisible: fd.get("customerVisible") === "true",
    });
    // Making an article customer-visible is a manager decision (it can be sent to customers).
    if (input.customerVisible && !can(u.role, "helpdesk.manage"))
      throw new ActionError("Only a helpdesk manager can make an article customer-visible.", {
        customerVisible: ["Requires helpdesk manager"],
      });
    const articleId = await saveArticle(
      id ? z.uuid().parse(id) : null,
      {
        title: input.title,
        body: input.body,
        summary: input.summary,
        category: input.category,
        tags: input.tags,
        customerVisible: input.customerVisible,
        reviewDueAt: input.reviewDueAt,
        changeNote: input.changeNote,
      },
      u.id,
      { fromTicketId: input.fromTicketId ? z.uuid().parse(input.fromTicketId) : null },
    );
    revalidate(input.fromTicketId ?? undefined);
    return { id: articleId };
  });
}

export async function setArticleStatusAction(
  id: string,
  status: "draft" | "published" | "archived",
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.manage");
    await setArticleStatus(z.uuid().parse(id), z.enum(["draft", "published", "archived"]).parse(status), u.id);
    revalidate();
    return undefined;
  });
}

export async function deleteArticleAction(id: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await deleteArticle(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}

export async function restoreRevisionAction(id: string, version: number): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await restoreRevision(z.uuid().parse(id), z.number().int().min(1).parse(version), u.id);
    revalidate();
    return undefined;
  });
}

export async function linkArticleAction(ticketId: string, articleId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await linkArticleToTicket(z.uuid().parse(ticketId), z.uuid().parse(articleId), { id: u.id, type: "user" });
    revalidate(ticketId);
    return undefined;
  });
}
export async function unlinkArticleAction(ticketId: string, articleId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await unlinkArticleFromTicket(z.uuid().parse(ticketId), z.uuid().parse(articleId), { id: u.id, type: "user" });
    revalidate(ticketId);
    return undefined;
  });
}

/** Returns the article text for the composer and records that it was sent when it goes to a customer. */
export async function insertArticleAction(
  ticketId: string,
  articleId: string,
  forCustomer: boolean,
): Promise<ActionResult<{ title: string; body: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const a = await articleBodyForInsert(z.uuid().parse(articleId), Boolean(forCustomer));
    await linkArticleToTicket(z.uuid().parse(ticketId), articleId, { id: u.id, type: "user" }, forCustomer ? "sent" : "linked");
    revalidate(ticketId);
    return a;
  });
}

export async function linkDeviceAction(ticketId: string, deviceId: string, note: string | null): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await linkDevice(z.uuid().parse(ticketId), z.uuid().parse(deviceId), { id: u.id, type: "user" }, note ? z.string().max(200).parse(note) : null);
    revalidate(ticketId);
    return undefined;
  });
}
export async function unlinkDeviceAction(ticketId: string, deviceId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    await unlinkDevice(z.uuid().parse(ticketId), z.uuid().parse(deviceId), { id: u.id, type: "user" });
    revalidate(ticketId);
    return undefined;
  });
}

export async function anonymiseTicketAction(ticketId: string): Promise<ActionResult<{ attachments: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const r = await anonymiseTicket(z.uuid().parse(ticketId), { id: u.id, type: "user" }, "admin request");
    revalidate(ticketId);
    return { attachments: r.attachments ?? 0 };
  });
}

export async function anonymiseByEmailAction(
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ tickets: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const email = z.string().trim().toLowerCase().email("Enter the requester's e-mail address").parse(String(fd.get("email") ?? ""));
    const r = await anonymiseByEmail(email, { id: u.id, type: "user" });
    revalidate();
    return r;
  });
}
