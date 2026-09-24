"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, ActionError, type ActionResult } from "@/lib/action-result";
import {
  cancelOutbox,
  composeNewEmail,
  connectMailbox,
  disconnectMailbox,
  ensureSubscription,
  getDefaultMailbox,
  getMailbox,
  mailboxTick,
  replayInbound,
  retryOutbox,
  runDeltaSync,
  saveMailboxSettings,
  sendTestEmail,
  sendTicketReply,
  storeUpload,
  testMailbox,
} from "@/services/mailbox";
import { deleteDraft } from "@/services/helpdesk";

const revalidate = (ticketId?: string) => {
  revalidatePath("/helpdesk", "layout");
  if (ticketId) revalidatePath(`/helpdesk/tickets/${ticketId}`);
};
const emails = (v: FormDataEntryValue | null) => [
  ...new Set(
    String(v ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

export async function connectMailboxAction(
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ id: string; displayName: string | null }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const input = z
      .object({
        address: z
          .string()
          .trim()
          .toLowerCase()
          .refine(
            (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
            "Enter the mailbox address",
          ),
        displayName: z
          .string()
          .trim()
          .max(120)
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        tenantId: z.string().trim().min(8, "Tenant id is required").max(200),
        clientId: z.string().trim().min(8, "Client id is required").max(200),
        authMode: z.enum(["secret", "certificate"]),
        clientSecret: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        privateKeyPem: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        certificatePem: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        credentialExpiresAt: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        importFrom: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
      })
      .refine(
        (v) =>
          v.authMode === "secret"
            ? Boolean(v.clientSecret)
            : Boolean(v.privateKeyPem && v.certificatePem),
        {
          message:
            "Provide the secret, or both the private key and certificate",
          path: ["clientSecret"],
        },
      )
      .parse({
        // Absent inputs (the credential fields of the other mode) arrive as
        // null, which must read as "blank", not as an invalid value.
        address: String(fd.get("address") ?? ""),
        displayName: String(fd.get("displayName") ?? ""),
        tenantId: String(fd.get("tenantId") ?? ""),
        clientId: String(fd.get("clientId") ?? ""),
        authMode: String(fd.get("authMode") || "secret"),
        clientSecret: String(fd.get("clientSecret") ?? ""),
        privateKeyPem: String(fd.get("privateKeyPem") ?? ""),
        certificatePem: String(fd.get("certificatePem") ?? ""),
        credentialExpiresAt: String(fd.get("credentialExpiresAt") ?? ""),
        importFrom: String(fd.get("importFrom") ?? ""),
      });
    const r = await connectMailbox(input, u.id);
    revalidate();
    return r;
  });
}

export async function testMailboxAction(
  id: string,
): Promise<ActionResult<{ ok: boolean; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const t = await testMailbox(z.uuid().parse(id), u.id);
    revalidate();
    return {
      ok: t.ok,
      message: t.ok
        ? `Mailbox ${t.displayName ?? ""} readable${t.canSend === null ? " (send is confirmed by the first real message)" : ""}`.trim()
        : t.error,
    };
  });
}

export async function disconnectMailboxAction(
  id: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await disconnectMailbox(z.uuid().parse(id), u.id);
    revalidate();
    return undefined;
  });
}

export async function saveMailboxSettingsAction(
  id: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const folders = String(fd.get("folders") ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [idPart, ...name] = l.split("|");
        return { id: idPart.trim(), name: (name.join("|") || idPart).trim() };
      });
    const input = z
      .object({
        displayName: z
          .string()
          .trim()
          .max(120)
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        importFrom: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        ackEnabled: z.boolean(),
        ackSubject: z.string().trim().min(1).max(300),
        ackBody: z.string().trim().min(1).max(5000),
        unknownSenderPolicy: z.enum(["create_unverified", "review"]),
        closedReplyPolicy: z.enum(["reopen", "follow_up"]),
        closedReopenDays: z.coerce.number().int().min(0).max(365),
        signature: z.string().trim().max(2000),
        credentialExpiresAt: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
      })
      .parse({
        displayName: String(fd.get("displayName") ?? ""),
        importFrom: String(fd.get("importFrom") ?? ""),
        ackEnabled: fd.get("ackEnabled") === "true",
        ackSubject: String(fd.get("ackSubject") ?? ""),
        ackBody: String(fd.get("ackBody") ?? ""),
        unknownSenderPolicy: String(fd.get("unknownSenderPolicy") ?? ""),
        closedReplyPolicy: String(fd.get("closedReplyPolicy") ?? ""),
        closedReopenDays: String(fd.get("closedReopenDays") ?? ""),
        signature: String(fd.get("signature") ?? ""),
        credentialExpiresAt: String(fd.get("credentialExpiresAt") ?? ""),
      });
    await saveMailboxSettings(
      z.uuid().parse(id),
      { ...input, folders: folders.length ? folders : undefined },
      u.id,
    );
    revalidate();
    return undefined;
  });
}

export async function sendTestEmailAction(
  id: string,
  to: string,
): Promise<ActionResult<{ status: string; error: string | null }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const row = await sendTestEmail(
      z.uuid().parse(id),
      z.string().trim().parse(to),
      u.id,
    );
    revalidate();
    return { status: row?.status ?? "queued", error: row?.lastError ?? null };
  });
}

export async function mailboxMaintenanceAction(
  id: string,
  op: "delta" | "subscription" | "tick",
): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const m = await getMailbox(z.uuid().parse(id));
    if (!m) throw new ActionError("Mailbox not found.");
    let message: string;
    if (op === "delta") {
      const r = await runDeltaSync(m, "manual", u.id);
      message = r
        ? r.status === "failed"
          ? (r.message ?? "failed")
          : `${r.counters.fetched} messages seen, ${r.counters.created} queued`
        : "Mailbox has no client.";
    } else if (op === "subscription") {
      const r = await ensureSubscription(m, true);
      message = r.action === "failed" ? r.error : `Subscription ${r.action}`;
    } else {
      const r = (await mailboxTick()) as {
        inbound?: { claimed: number; done: number; failed: number };
        outbox?: { attempted: number; accepted: number; failed: number };
      };
      message = `Inbound: ${r.inbound?.claimed ?? 0} processed (${r.inbound?.failed ?? 0} failed). Outbox: ${r.outbox?.accepted ?? 0} accepted, ${r.outbox?.failed ?? 0} failed.`;
    }
    revalidate();
    return { message };
  });
}

export async function replayInboundAction(
  queueId: string,
): Promise<ActionResult<{ ok: boolean }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const ok = await replayInbound(z.uuid().parse(queueId), u.id);
    revalidate();
    return { ok };
  });
}
export async function retryOutboxAction(
  outboxId: string,
): Promise<ActionResult<{ status: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    const status = await retryOutbox(z.uuid().parse(outboxId), u.id);
    revalidate();
    return { status };
  });
}
export async function cancelOutboxAction(
  outboxId: string,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.admin");
    await cancelOutbox(z.uuid().parse(outboxId), u.id);
    revalidate();
    return undefined;
  });
}

/** Agent reply by e-mail (public). Attachments come from earlier uploadAttachmentAction calls; the idempotency key stops double submits. */
export async function sendReplyAction(
  ticketId: string,
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ outboxId: string; reused: boolean }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const id = z.uuid().parse(ticketId);
    const input = z
      .object({
        body: z.string().trim().min(1, "Write something first").max(50_000),
        idempotencyKey: z.string().min(8).max(100),
        status: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        version: z.coerce.number().int().optional(),
        replyToMessageId: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
      })
      .parse({
        body: fd.get("body"),
        idempotencyKey: fd.get("idempotencyKey"),
        status: String(fd.get("status") ?? ""),
        version: fd.get("version") || undefined,
        replyToMessageId: String(fd.get("replyToMessageId") ?? ""),
      });
    const attachmentIds = fd
      .getAll("attachmentIds")
      .map(String)
      .filter(Boolean);
    const r = await sendTicketReply(
      id,
      {
        markdown: input.body,
        to: emails(fd.get("to")),
        cc: emails(fd.get("cc")),
        bcc: emails(fd.get("bcc")),
        replyToMessageId: input.replyToMessageId,
        attachmentIds,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        version: input.version,
      },
      { id: u.id, type: "user", name: u.name, email: u.email },
    );
    await deleteDraft(id, u.id);
    revalidate(id);
    return { outboxId: r.outboxId, reused: r.reused };
  });
}

export async function composeEmailAction(
  _prev: ActionResult<unknown> | null,
  fd: FormData,
): Promise<ActionResult<{ ticketId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const input = z
      .object({
        subject: z.string().trim().min(1, "Subject is required").max(300),
        body: z.string().trim().min(1, "Write something first").max(50_000),
        idempotencyKey: z.string().min(8).max(100),
        companyId: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
        contactId: z
          .string()
          .optional()
          .or(z.literal(""))
          .transform((v) => v || null),
      })
      .parse({
        subject: fd.get("subject"),
        body: fd.get("body"),
        idempotencyKey: fd.get("idempotencyKey"),
        companyId: String(fd.get("companyId") ?? ""),
        contactId: String(fd.get("contactId") ?? ""),
      });
    const r = await composeNewEmail(
      {
        subject: input.subject,
        markdown: input.body,
        to: emails(fd.get("to")),
        cc: emails(fd.get("cc")),
        bcc: emails(fd.get("bcc")),
        companyId: input.companyId ? z.uuid().parse(input.companyId) : null,
        contactId: input.contactId ? z.uuid().parse(input.contactId) : null,
        attachmentIds: fd.getAll("attachmentIds").map(String).filter(Boolean),
        idempotencyKey: input.idempotencyKey,
      },
      { id: u.id, type: "user", name: u.name, email: u.email },
    );
    revalidate();
    return { ticketId: r.ticketId };
  });
}

/** Stores one uploaded file (scanned) and returns its attachment id for the composer. */
export async function uploadAttachmentAction(
  ticketId: string | null,
  fd: FormData,
): Promise<ActionResult<{ id: string; name: string; size: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("helpdesk.agent");
    const file = fd.get("file");
    if (!(file instanceof File)) throw new ActionError("Choose a file.");
    const bytes = Buffer.from(await file.arrayBuffer());
    // Uploads before a ticket exists (compose page) attach to a holding ticket id of the mailbox row; compose re-parents them.
    const tid = ticketId ? z.uuid().parse(ticketId) : null;
    if (!tid) {
      const m = await getDefaultMailbox();
      if (!m) throw new ActionError("No mailbox available.");
    }
    const id = await storeUpload(
      tid ?? (await holdingTicketId(u.id)),
      { name: file.name, type: file.type, bytes },
      u.id,
      fd.get("restricted") === "true",
    );
    return { id, name: file.name, size: bytes.length };
  });
}

/** A per-user "drafts" ticket that only holds uploads until compose creates the real ticket. */
async function holdingTicketId(userId: string) {
  const { db } = await import("@/db");
  const { tickets } = await import("@/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [existing] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.createdByUserId, userId),
        eq(tickets.subject, "__compose_uploads__"),
        eq(tickets.status, "cancelled"),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(tickets)
    .values({
      subject: "__compose_uploads__",
      status: "cancelled",
      source: "manual",
      createdByUserId: userId,
    })
    .returning({ id: tickets.id });
  return row.id;
}
