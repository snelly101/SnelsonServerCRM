import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  companies,
  helpdeskMailboxes,
  mailboxInboundQueue,
  mailboxOutbox,
  ticketAttachments,
  ticketMessages,
  ticketParticipants,
  tickets,
  user,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { audit, logActivity } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import { logger } from "@/lib/logger";
import { normalizeEmail } from "@/lib/utils";
import { markdownToHtml, markdownToPlainText } from "@/lib/markdown-parse";
import {
  m365ClientFor,
  type M365Client,
  type M365Credentials,
  type M365Token,
} from "@/connectors/m365";
import {
  header,
  normalizeMessageId,
  recipient,
  recipients,
  splitReferences,
  type GraphMessage,
  type OutboundDraft,
} from "@/connectors/m365/types";
import { htmlToText, sanitizeEmailHtml } from "@/lib/email/sanitize";
import { splitQuotedText } from "@/lib/email/quotes";
import { bounceDetails, classifyAutomated } from "@/lib/email/automated";
import { afterTicketChange } from "./helpdesk-hooks";
import { describeError } from "@/lib/integrations/http";
import { notifyUsers, ticketAudience } from "./helpdesk-notifications";
import {
  checkAttachmentPolicy,
  readAttachmentBytes,
  scanBytes,
  sha256,
  storeAttachmentBytes,
} from "@/lib/email/storage";
import {
  addSyncError,
  runSync,
  startSyncRun,
  finishSyncRun,
} from "./integrations";
import {
  changeStatus,
  createTicket,
  findTicketByReference,
  recordEvent,
  type Actor,
} from "./helpdesk";
import {
  findTicketReferences,
  ticketReference,
} from "@/lib/validation-helpdesk";

export type Mailbox = typeof helpdeskMailboxes.$inferSelect;
type MailboxCreds = M365Credentials;
const EMAIL_ACTOR: Actor = { id: null, type: "email" };
const SUBSCRIPTION_MINUTES = 4200; // Graph maximum for mail is 4230
const RENEW_WHEN_LEFT_MS = 24 * 3600 * 1000;
const MAX_INBOUND_ATTEMPTS = 8;
const MAX_OUTBOUND_ATTEMPTS = 6;
const ACK_RATE_LIMIT_PER_HOUR = 3;

// ---------------------------------------------------------------------------
// Mailbox rows, credentials and clients
// ---------------------------------------------------------------------------
export async function listMailboxes() {
  return db
    .select()
    .from(helpdeskMailboxes)
    .orderBy(desc(helpdeskMailboxes.isDefault), asc(helpdeskMailboxes.address));
}
export async function getMailbox(id: string) {
  const [m] = await db
    .select()
    .from(helpdeskMailboxes)
    .where(eq(helpdeskMailboxes.id, id))
    .limit(1);
  return m ?? null;
}
/** The mailbox that sends and receives: the default active one, or a demo mailbox row in demo mode. */
export async function getDefaultMailbox(): Promise<Mailbox | null> {
  const [m] = await db
    .select()
    .from(helpdeskMailboxes)
    .where(eq(helpdeskMailboxes.active, true))
    .orderBy(
      desc(helpdeskMailboxes.isDefault),
      asc(helpdeskMailboxes.createdAt),
    )
    .limit(1);
  if (m) return m;
  if (process.env.DEMO_MODE === "true") {
    const [created] = await db
      .insert(helpdeskMailboxes)
      .values({
        address: process.env.HELPDESK_DEMO_MAILBOX ?? "support@example.com",
        displayName: "Demo support mailbox",
        status: "not_configured",
        importFrom: new Date(Date.now() - 86400000),
      })
      .onConflictDoNothing()
      .returning();
    return (
      created ?? (await db.select().from(helpdeskMailboxes).limit(1))[0] ?? null
    );
  }
  return null;
}
function credsOf(m: Mailbox): MailboxCreds | null {
  if (!m.credentialsEnc) return null;
  try {
    return JSON.parse(decryptSecret(m.credentialsEnc)) as MailboxCreds;
  } catch {
    return null;
  }
}
export async function clientForMailbox(
  m: Mailbox,
): Promise<{ client: M365Client; mode: "live" | "demo" } | null> {
  const creds = credsOf(m);
  return m365ClientFor(creds, m.address, async (token: M365Token) => {
    if (!creds) return;
    await db
      .update(helpdeskMailboxes)
      .set({
        credentialsEnc: encryptSecret(JSON.stringify({ ...creds, token })),
      })
      .where(eq(helpdeskMailboxes.id, m.id));
  });
}
export function mailboxIsLive(m: Mailbox) {
  return Boolean(m.credentialsEnc) && m.status !== "disconnected";
}

export async function connectMailbox(
  input: {
    address: string;
    displayName: string | null;
    tenantId: string;
    clientId: string;
    authMode: "secret" | "certificate";
    clientSecret?: string | null;
    privateKeyPem?: string | null;
    certificatePem?: string | null;
    credentialExpiresAt?: string | null;
    importFrom?: string | null;
  },
  actorUserId: string,
) {
  const address = input.address.trim().toLowerCase();
  const creds: MailboxCreds = {
    tenantId: input.tenantId.trim(),
    clientId: input.clientId.trim(),
    authMode: input.authMode,
    clientSecret:
      input.authMode === "secret"
        ? (input.clientSecret ?? undefined)
        : undefined,
    privateKeyPem:
      input.authMode === "certificate"
        ? (input.privateKeyPem ?? undefined)
        : undefined,
    certificatePem:
      input.authMode === "certificate"
        ? (input.certificatePem ?? undefined)
        : undefined,
  };
  const resolved = m365ClientFor(creds, address, async () => undefined);
  if (!resolved || resolved.mode !== "live")
    throw new ActionError(
      "Enter the tenant id, client id and a secret or certificate.",
    );
  const test = await resolved.client.testMailbox(address);
  if (!test.ok)
    throw new ActionError(`Could not access the mailbox: ${test.error}`);
  const [existing] = await db
    .select()
    .from(helpdeskMailboxes)
    .where(eq(helpdeskMailboxes.address, address))
    .limit(1);
  const values = {
    address,
    displayName: input.displayName ?? test.displayName,
    tenantId: creds.tenantId,
    authMode: input.authMode,
    credentialsEnc: encryptSecret(JSON.stringify(creds)),
    credentialExpiresAt: input.credentialExpiresAt
      ? new Date(input.credentialExpiresAt)
      : null,
    status: "connected" as const,
    lastError: null,
    lastTestedAt: new Date(),
    importFrom: input.importFrom
      ? new Date(input.importFrom)
      : (existing?.importFrom ?? new Date()),
    connectedByUserId: actorUserId,
    active: true,
    subscriptionError: null,
    updatedAt: new Date(),
  };
  let id: string;
  if (existing) {
    await db
      .update(helpdeskMailboxes)
      .set(values)
      .where(eq(helpdeskMailboxes.id, existing.id));
    id = existing.id;
  } else {
    // Any leftover demo placeholder becomes this mailbox's row so tickets keep their mailbox id.
    const [placeholder] = await db
      .select()
      .from(helpdeskMailboxes)
      .where(isNull(helpdeskMailboxes.credentialsEnc))
      .limit(1);
    if (placeholder) {
      await db
        .update(helpdeskMailboxes)
        .set(values)
        .where(eq(helpdeskMailboxes.id, placeholder.id));
      id = placeholder.id;
    } else
      id = (
        await db
          .insert(helpdeskMailboxes)
          .values(values)
          .returning({ id: helpdeskMailboxes.id })
      )[0].id;
  }
  await audit({
    actorUserId,
    action: "mailbox.connect",
    entityType: "helpdesk_mailbox",
    entityId: id,
    details: { address, tenantId: creds.tenantId, authMode: input.authMode },
  });
  const mb = (await getMailbox(id))!;
  await ensureSubscription(mb, true).catch((err) =>
    logger.warn({ err: String(err) }, "subscription after connect failed"),
  );
  return { id, displayName: values.displayName };
}

export async function testMailbox(id: string, actorUserId: string) {
  const m = await getMailbox(id);
  if (!m) throw new ActionError("Mailbox not found.");
  const resolved = await clientForMailbox(m);
  if (!resolved) throw new ActionError("This mailbox has no credentials.");
  const t = await resolved.client.testMailbox(m.address);
  if (resolved.mode === "live")
    await db
      .update(helpdeskMailboxes)
      .set({
        lastTestedAt: new Date(),
        lastError: t.ok ? null : t.error,
        status: t.ok
          ? "connected"
          : t.status === 401 || t.status === 403
            ? "expired"
            : "error",
        updatedAt: new Date(),
      })
      .where(eq(helpdeskMailboxes.id, id));
  await audit({
    actorUserId,
    action: "mailbox.test",
    entityType: "helpdesk_mailbox",
    entityId: id,
    details: { ok: t.ok },
  });
  return t;
}

export async function disconnectMailbox(id: string, actorUserId: string) {
  const m = await getMailbox(id);
  if (!m) return;
  const resolved = await clientForMailbox(m);
  if (resolved?.mode === "live" && m.subscriptionId)
    await resolved.client
      .deleteSubscription(m.subscriptionId)
      .catch(() => undefined);
  await db
    .update(helpdeskMailboxes)
    .set({
      credentialsEnc: null,
      status: "disconnected",
      subscriptionId: null,
      subscriptionExpiresAt: null,
      subscriptionClientState: null,
      deltaLinks: {},
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(helpdeskMailboxes.id, id));
  await audit({
    actorUserId,
    action: "mailbox.disconnect",
    entityType: "helpdesk_mailbox",
    entityId: id,
  });
}

export async function saveMailboxSettings(
  id: string,
  input: {
    displayName?: string | null;
    folders?: { id: string; name: string }[];
    importFrom?: string | null;
    ackEnabled?: boolean;
    ackSubject?: string;
    ackBody?: string;
    unknownSenderPolicy?: "create_unverified" | "review";
    closedReplyPolicy?: "reopen" | "follow_up";
    closedReopenDays?: number;
    signature?: string;
    credentialExpiresAt?: string | null;
  },
  actorUserId: string,
) {
  const m = await getMailbox(id);
  if (!m) throw new ActionError("Mailbox not found.");
  const patch: Partial<typeof helpdeskMailboxes.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.folders) {
    patch.folders = input.folders;
    // Folder change: drop delta state for folders no longer watched.
    patch.deltaLinks = Object.fromEntries(
      Object.entries(m.deltaLinks).filter(([k]) =>
        input.folders!.some((f) => f.id === k),
      ),
    );
  }
  if (input.importFrom !== undefined)
    patch.importFrom = input.importFrom ? new Date(input.importFrom) : null;
  if (input.ackEnabled !== undefined) patch.ackEnabled = input.ackEnabled;
  if (input.ackSubject !== undefined) patch.ackSubject = input.ackSubject;
  if (input.ackBody !== undefined) patch.ackBody = input.ackBody;
  if (input.unknownSenderPolicy)
    patch.unknownSenderPolicy = input.unknownSenderPolicy;
  if (input.closedReplyPolicy)
    patch.closedReplyPolicy = input.closedReplyPolicy;
  if (input.closedReopenDays !== undefined)
    patch.closedReopenDays = input.closedReopenDays;
  if (input.signature !== undefined) patch.signature = input.signature;
  if (input.credentialExpiresAt !== undefined)
    patch.credentialExpiresAt = input.credentialExpiresAt
      ? new Date(input.credentialExpiresAt)
      : null;
  await db
    .update(helpdeskMailboxes)
    .set(patch)
    .where(eq(helpdeskMailboxes.id, id));
  await audit({
    actorUserId,
    action: "mailbox.settings",
    entityType: "helpdesk_mailbox",
    entityId: id,
    details: { keys: Object.keys(input) },
  });
  if (input.folders && mailboxIsLive(m))
    await ensureSubscription((await getMailbox(id))!, true).catch(
      () => undefined,
    );
}

// ---------------------------------------------------------------------------
// Change notifications (subscriptions) and the webhook handler
// ---------------------------------------------------------------------------
function notificationUrls() {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  return {
    notificationUrl: `${base}/api/webhooks/m365`,
    lifecycleUrl: `${base}/api/webhooks/m365?lifecycle=1`,
  };
}

/** Creates the subscription on the first monitored folder, renews when under a day is left, recreates when Graph forgot it. */
export async function ensureSubscription(m: Mailbox, force = false) {
  const resolved = await clientForMailbox(m);
  if (!resolved || !mailboxIsLive(m)) return { action: "skipped" as const };
  const folder = m.folders[0]?.id ?? "inbox";
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60000);
  const { notificationUrl, lifecycleUrl } = notificationUrls();
  try {
    if (m.subscriptionId && m.subscriptionExpiresAt && !force) {
      if (m.subscriptionExpiresAt.getTime() - Date.now() > RENEW_WHEN_LEFT_MS)
        return { action: "current" as const };
      try {
        const sub = await resolved.client.renewSubscription(
          m.subscriptionId,
          expiresAt,
        );
        await db
          .update(helpdeskMailboxes)
          .set({
            subscriptionExpiresAt: new Date(sub.expirationDateTime),
            subscriptionError: null,
            updatedAt: new Date(),
          })
          .where(eq(helpdeskMailboxes.id, m.id));
        return { action: "renewed" as const };
      } catch (err) {
        logger.warn(
          { mailbox: m.address, err: String(err) },
          "subscription renewal failed; recreating",
        );
      }
    }
    if (m.subscriptionId)
      await resolved.client
        .deleteSubscription(m.subscriptionId)
        .catch(() => undefined);
    const clientState = randomBytes(24).toString("base64url");
    const sub = await resolved.client.createSubscription(
      m.address,
      folder,
      notificationUrl,
      lifecycleUrl,
      clientState,
      expiresAt,
    );
    await db
      .update(helpdeskMailboxes)
      .set({
        subscriptionId: sub.id,
        subscriptionExpiresAt: new Date(sub.expirationDateTime),
        subscriptionClientState: clientState,
        subscriptionError: null,
        updatedAt: new Date(),
      })
      .where(eq(helpdeskMailboxes.id, m.id));
    return { action: "created" as const };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(helpdeskMailboxes)
      .set({
        subscriptionError: message.slice(0, 500),
        status: /401|403/.test(message) ? "expired" : m.status,
        updatedAt: new Date(),
      })
      .where(eq(helpdeskMailboxes.id, m.id));
    return { action: "failed" as const, error: message };
  }
}

export type GraphNotificationPayload = {
  value?: {
    subscriptionId?: string;
    clientState?: string;
    changeType?: string;
    lifecycleEvent?: string;
    resource?: string;
    resourceData?: { id?: string; "@odata.type"?: string };
  }[];
};

/** Validates every notification against the stored clientState, then enqueues. Returns what happened per notification. */
export async function handleGraphNotifications(
  payload: GraphNotificationPayload,
) {
  const results: { subscriptionId: string | null; outcome: string }[] = [];
  for (const n of payload.value ?? []) {
    const subscriptionId = n.subscriptionId ?? null;
    if (!subscriptionId) {
      results.push({ subscriptionId, outcome: "ignored: no subscription id" });
      continue;
    }
    const [m] = await db
      .select()
      .from(helpdeskMailboxes)
      .where(eq(helpdeskMailboxes.subscriptionId, subscriptionId))
      .limit(1);
    if (!m) {
      results.push({
        subscriptionId,
        outcome: "ignored: unknown subscription",
      });
      continue;
    }
    if (
      !m.subscriptionClientState ||
      n.clientState !== m.subscriptionClientState
    ) {
      logger.warn(
        { subscriptionId },
        "notification with bad clientState rejected",
      );
      results.push({
        subscriptionId,
        outcome: "rejected: clientState mismatch",
      });
      continue;
    }
    await db
      .update(helpdeskMailboxes)
      .set({ lastNotificationAt: new Date() })
      .where(eq(helpdeskMailboxes.id, m.id));
    if (n.lifecycleEvent) {
      // subscriptionRemoved | missed | reauthorizationRequired: recover through the delta sync and re-subscribe.
      await db
        .update(helpdeskMailboxes)
        .set({
          subscriptionError: `lifecycle: ${n.lifecycleEvent}`,
          subscriptionExpiresAt:
            n.lifecycleEvent === "subscriptionRemoved"
              ? null
              : m.subscriptionExpiresAt,
        })
        .where(eq(helpdeskMailboxes.id, m.id));
      if (
        n.lifecycleEvent === "reauthorizationRequired" ||
        n.lifecycleEvent === "subscriptionRemoved"
      )
        await ensureSubscription(
          {
            ...m,
            subscriptionId:
              n.lifecycleEvent === "subscriptionRemoved"
                ? null
                : m.subscriptionId,
          },
          true,
        ).catch(() => undefined);
      await enqueueDelta(m.id);
      results.push({
        subscriptionId,
        outcome: `lifecycle ${n.lifecycleEvent} handled`,
      });
      continue;
    }
    const externalId = n.resourceData?.id;
    if (!externalId) {
      results.push({ subscriptionId, outcome: "ignored: no resource id" });
      continue;
    }
    const inserted = await enqueueInbound(m.id, externalId, "notification");
    results.push({
      subscriptionId,
      outcome: inserted ? "queued" : "duplicate",
    });
  }
  return results;
}

/** Marks the mailbox for a delta run on the next tick (the worker calls runDeltaSync). */
async function enqueueDelta(mailboxId: string) {
  await db
    .update(helpdeskMailboxes)
    .set({
      deltaLinks: sql`${helpdeskMailboxes.deltaLinks} || '{"__force": "1"}'::jsonb`,
    })
    .where(eq(helpdeskMailboxes.id, mailboxId));
}

export async function enqueueInbound(
  mailboxId: string,
  externalMessageId: string,
  source: "notification" | "delta" | "manual" | "replay",
) {
  const [row] = await db
    .insert(mailboxInboundQueue)
    .values({ mailboxId, externalMessageId, source })
    .onConflictDoNothing({
      target: [
        mailboxInboundQueue.mailboxId,
        mailboxInboundQueue.externalMessageId,
      ],
    })
    .returning({ id: mailboxInboundQueue.id });
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Delta synchronisation (recovers anything a notification missed)
// ---------------------------------------------------------------------------
export async function runDeltaSync(
  m: Mailbox,
  trigger: "schedule" | "manual" = "schedule",
  actorUserId?: string | null,
) {
  const resolved = await clientForMailbox(m);
  if (!resolved) return null;
  return runSync(
    "m365",
    "m365.delta",
    trigger,
    async ({ counters, fail }) => {
      let queued = 0;
      const links: Record<string, string> = { ...m.deltaLinks };
      delete links.__force;
      for (const folder of m.folders) {
        let link: string | null = links[folder.id] ?? null;
        let since: Date | null = link
          ? null
          : (m.importFrom ?? new Date(Date.now() - 86400000));
        for (let page = 0; page < 200; page++) {
          let res;
          try {
            res = await resolved.client.deltaMessages(
              m.address,
              folder.id,
              link,
              since,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/410|SyncStateNotFound|gone/i.test(msg) && link) {
              // Expired delta token: start again from the last successful sync (minus a day of overlap); duplicates are absorbed by the queue.
              await fail(
                `Delta state for ${folder.name} expired; resynchronising from ${m.lastInboundSyncAt?.toISOString() ?? "import cutoff"}`,
              );
              link = null;
              since = m.lastInboundSyncAt
                ? new Date(m.lastInboundSyncAt.getTime() - 86400000)
                : (m.importFrom ?? new Date(Date.now() - 86400000));
              continue;
            }
            throw err;
          }
          for (const msg of res.messages) {
            counters.fetched++;
            if (msg["@removed"] || msg.isDraft) continue;
            if (
              m.importFrom &&
              msg.receivedDateTime &&
              new Date(msg.receivedDateTime) < m.importFrom
            )
              continue;
            if (await enqueueInbound(m.id, msg.id, "delta")) queued++;
          }
          if (res.nextLink) {
            link = res.nextLink;
            since = null;
            continue;
          }
          if (res.deltaLink) links[folder.id] = res.deltaLink;
          break;
        }
      }
      await db
        .update(helpdeskMailboxes)
        .set({
          deltaLinks: links,
          lastInboundSyncAt: new Date(),
          lastError: null,
          status: mailboxIsLive(m) ? "connected" : m.status,
          updatedAt: new Date(),
        })
        .where(eq(helpdeskMailboxes.id, m.id));
      counters.created = queued;
      return `${counters.fetched} messages seen, ${queued} queued${resolved.mode === "demo" ? " (DEMO mailbox)" : ""}`;
    },
    actorUserId,
  ).then(async (r) => {
    if (
      r?.status === "failed" &&
      r.message &&
      /401|403|InvalidAuthenticationToken/i.test(r.message)
    )
      await db
        .update(helpdeskMailboxes)
        .set({ status: "expired", lastError: r.message })
        .where(eq(helpdeskMailboxes.id, m.id));
    else if (r?.status === "failed")
      await db
        .update(helpdeskMailboxes)
        .set({ lastError: r.message ?? "delta sync failed" })
        .where(eq(helpdeskMailboxes.id, m.id));
    return r;
  });
}

// ---------------------------------------------------------------------------
// Inbound processing
// ---------------------------------------------------------------------------
/** Claims up to `limit` pending rows with SKIP LOCKED so concurrent workers never process the same message. */
export async function processInboundQueue(limit = 25) {
  const claimed = await db.execute<{ id: string }>(sql`
    update mailbox_inbound_queue set status = 'processing', attempts = attempts + 1
     where id in (select id from mailbox_inbound_queue where status = 'pending' and next_attempt_at <= now() order by received_at limit ${limit} for update skip locked)
    returning id`);
  let done = 0;
  let failed = 0;
  for (const row of claimed.rows) {
    const ok = await processInboundRow(row.id);
    if (ok) done++;
    else failed++;
  }
  return { claimed: claimed.rows.length, done, failed };
}

export async function processInboundRow(queueId: string) {
  const [row] = await db
    .select()
    .from(mailboxInboundQueue)
    .where(eq(mailboxInboundQueue.id, queueId))
    .limit(1);
  if (!row) return false;
  const m = await getMailbox(row.mailboxId);
  const resolved = m ? await clientForMailbox(m) : null;
  if (!m || !resolved) {
    await db
      .update(mailboxInboundQueue)
      .set({
        status: "dead",
        lastError: "mailbox not available",
        processedAt: new Date(),
      })
      .where(eq(mailboxInboundQueue.id, queueId));
    return false;
  }
  try {
    const outcome = await processInboundMessage(
      m,
      resolved.client,
      row.externalMessageId,
      row.source,
    );
    await db
      .update(mailboxInboundQueue)
      .set({
        status: outcome.action === "skipped" ? "skipped" : "done",
        outcome,
        ticketId: outcome.ticketId ?? null,
        lastError: null,
        processedAt: new Date(),
      })
      .where(eq(mailboxInboundQueue.id, queueId));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = row.attempts + 1;
    const dead = attempts >= MAX_INBOUND_ATTEMPTS;
    const backoffMs = Math.min(3600_000, 30_000 * 2 ** Math.min(attempts, 7));
    await db
      .update(mailboxInboundQueue)
      .set({
        status: dead ? "dead" : "pending",
        lastError: message.slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + backoffMs),
        processedAt: dead ? new Date() : null,
      })
      .where(eq(mailboxInboundQueue.id, queueId));
    if (/401|403|InvalidAuthenticationToken/i.test(message))
      await db
        .update(helpdeskMailboxes)
        .set({ status: "expired", lastError: message.slice(0, 500) })
        .where(eq(helpdeskMailboxes.id, m.id));
    const runId = await startSyncRun("m365", "m365.inbound", "schedule");
    await addSyncError(
      runId,
      "m365",
      `Inbound ${row.externalMessageId}: ${message}`,
      { externalId: row.externalMessageId },
    );
    await finishSyncRun(runId, "failed", { fetched: 1, errors: 1 }, message);
    logger.error(
      { queueId, attempts, dead, err: message },
      "inbound processing failed",
    );
    return false;
  }
}

export type InboundOutcome = {
  action:
    | "created"
    | "appended"
    | "review"
    | "follow_up"
    | "bounce"
    | "skipped"
    | "duplicate";
  ticketId?: string;
  reason?: string;
  automated?: string | null;
};

async function staffEmails() {
  return new Set(
    (
      await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.active, true))
    ).map((u) => u.email.toLowerCase()),
  );
}
async function participantsOf(ticketId: string) {
  const rows = await db
    .select({ email: ticketParticipants.normalizedEmail })
    .from(ticketParticipants)
    .where(eq(ticketParticipants.ticketId, ticketId));
  return new Set(
    rows.map((r) => r.email).filter((e): e is string => Boolean(e)),
  );
}

/** Follows merges to the surviving ticket. */
async function surviving(ticketId: string) {
  let [t] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  let hops = 0;
  while (t?.mergedIntoTicketId && hops++ < 10) {
    const [next] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, t.mergedIntoTicketId))
      .limit(1);
    if (!next) break;
    t = next;
  }
  return t ?? null;
}

export async function processInboundMessage(
  m: Mailbox,
  client: M365Client,
  externalId: string,
  source = "notification",
): Promise<InboundOutcome> {
  void source;
  const msg = await client.getMessage(m.address, externalId);
  if (!msg)
    return { action: "skipped", reason: "message no longer in the mailbox" };
  if (msg.isDraft) return { action: "skipped", reason: "draft" };
  const internetMessageId = normalizeMessageId(
    msg.internetMessageId ?? header(msg, "Message-ID"),
  );
  // Dedupe on provider id and on Message-ID (a replayed notification, a delta overlap, or the same mail moved between folders).
  const [dupe] = await db
    .select({ id: ticketMessages.id, ticketId: ticketMessages.ticketId })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.mailboxId, m.id),
        or(
          eq(ticketMessages.externalMessageId, externalId),
          internetMessageId
            ? eq(ticketMessages.internetMessageId, internetMessageId)
            : sql`false`,
        ),
      ),
    )
    .limit(1);
  if (dupe) return { action: "duplicate", ticketId: dupe.ticketId };

  const from = recipient(msg.from) ?? recipient(msg.sender);
  const fromEmail = from?.email ?? null;
  // Mail the support mailbox sent itself (our outbox, or an agent in Outlook).
  if (fromEmail === m.address) {
    const [own] = await db
      .select({ id: mailboxOutbox.id })
      .from(mailboxOutbox)
      .where(
        and(
          eq(mailboxOutbox.mailboxId, m.id),
          or(
            eq(mailboxOutbox.providerMessageId, externalId),
            internetMessageId
              ? eq(mailboxOutbox.internetMessageId, internetMessageId)
              : sql`false`,
          ),
        ),
      )
      .limit(1);
    if (own) return { action: "skipped", reason: "sent by the CRM" };
  }

  const automated = classifyAutomated(msg);
  const isHtml = msg.body?.contentType === "html";
  const rawHtml = isHtml ? (msg.body?.content ?? "") : null;
  const fullText = isHtml
    ? htmlToText(rawHtml ?? "")
    : (msg.body?.content ?? "");
  const { body: newText, quoted } = splitQuotedText(fullText);
  const subject = msg.subject?.trim() || "(no subject)";
  const inReplyTo = normalizeMessageId(header(msg, "In-Reply-To"));
  const references = splitReferences(header(msg, "References"));
  const threadIds = [
    ...new Set(
      [inReplyTo, ...references].filter((x): x is string => Boolean(x)),
    ),
  ];

  // 1. Strong match: reply headers point at a message we hold in this mailbox.
  let strong: string | null = null;
  if (threadIds.length) {
    const [hit] = await db
      .select({ ticketId: ticketMessages.ticketId })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.mailboxId, m.id),
          inArray(ticketMessages.internetMessageId, threadIds),
        ),
      )
      .orderBy(desc(ticketMessages.at))
      .limit(1);
    strong = hit?.ticketId ?? null;
  }
  // 2. Weak signals: mailbox-scoped conversation id, then a reference in the subject.
  let weak: string | null = null;
  let weakReason = "";
  if (!strong && msg.conversationId) {
    const [hit] = await db
      .select({ ticketId: ticketMessages.ticketId })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.mailboxId, m.id),
          eq(ticketMessages.conversationId, msg.conversationId),
        ),
      )
      .orderBy(desc(ticketMessages.at))
      .limit(1);
    if (hit) {
      weak = hit.ticketId;
      weakReason = "same conversation";
    }
  }
  if (!strong && !weak) {
    for (const n of findTicketReferences(subject)) {
      const t = await findTicketByReference(n, false);
      if (t) {
        weak = t.id;
        weakReason = `subject references ${ticketReference(n)}`;
        break;
      }
    }
  }
  const candidateId = strong ?? weak;
  const candidate = candidateId ? await surviving(candidateId) : null;
  let authorised = false;
  if (candidate && fromEmail) {
    const parts = await participantsOf(candidate.id);
    authorised =
      parts.has(fromEmail) ||
      (await staffEmails()).has(fromEmail) ||
      fromEmail === m.address;
  }

  // Bounces: tie to what we sent, never open tickets.
  if (automated.kind === "bounce") {
    const details = bounceDetails(msg, fullText);
    const [sent] = details.originalMessageId
      ? await db
          .select()
          .from(mailboxOutbox)
          .where(
            and(
              eq(mailboxOutbox.mailboxId, m.id),
              eq(
                mailboxOutbox.internetMessageId,
                normalizeMessageId(details.originalMessageId)!,
              ),
            ),
          )
          .limit(1)
      : candidate
        ? await db
            .select()
            .from(mailboxOutbox)
            .where(
              and(
                eq(mailboxOutbox.mailboxId, m.id),
                eq(mailboxOutbox.ticketId, candidate.id),
              ),
            )
            .orderBy(desc(mailboxOutbox.createdAt))
            .limit(1)
        : [];
    const ticketId = sent?.ticketId ?? candidate?.id ?? null;
    if (!ticketId)
      return {
        action: "skipped",
        reason: "bounce that matches nothing we sent",
        automated: "bounce",
      };
    await db.transaction(async (tx) => {
      if (sent?.messageId)
        await tx
          .update(ticketMessages)
          .set({
            deliveryStatus: "bounced",
            deliveryDetail: `Bounced${details.failedRecipient ? ` for ${details.failedRecipient}` : ""}`,
          })
          .where(eq(ticketMessages.id, sent.messageId));
      if (sent)
        await tx
          .update(mailboxOutbox)
          .set({
            lastError: `bounced${details.failedRecipient ? `: ${details.failedRecipient}` : ""}`,
          })
          .where(eq(mailboxOutbox.id, sent.id));
      await tx.insert(ticketMessages).values({
        ticketId,
        kind: "internal",
        channel: "email",
        direction: "inbound",
        at: new Date(msg.receivedDateTime ?? Date.now()),
        fromName: from?.name ?? null,
        fromEmail,
        subject,
        bodyText: newText,
        bodyHtml: null,
        quotedText: quoted,
        isAutomated: true,
        automatedReason: "bounce",
        mailboxId: m.id,
        externalMessageId: externalId,
        internetMessageId,
        inReplyTo,
        references,
        conversationId: msg.conversationId ?? null,
        metadata: { bounce: details },
      });
      await tx
        .update(tickets)
        .set({
          needsReview: true,
          reviewReason: `Delivery failed${details.failedRecipient ? ` for ${details.failedRecipient}` : ""}; the customer may not have received the last reply.`,
          lastActivityAt: new Date(),
        })
        .where(eq(tickets.id, ticketId));
      await recordEvent(
        ticketId,
        "bounce",
        `Delivery failure received${details.failedRecipient ? ` for ${details.failedRecipient}` : ""}`,
        EMAIL_ACTOR,
        {
          outboxId: sent?.id ?? null,
          failedRecipient: details.failedRecipient,
        },
        tx,
      );
    });
    await notifyUsers(await ticketAudience(ticketId), {
      kind: "bounce",
      title: `Delivery failed${details.failedRecipient ? ` for ${details.failedRecipient}` : ""}`,
      body: subject,
      ticketId,
    });
    return { action: "bounce", ticketId, automated: "bounce" };
  }

  // Decide.
  const base = {
    msg,
    m,
    externalId,
    internetMessageId,
    inReplyTo,
    references,
    subject,
    from,
    fromEmail,
    newText,
    quoted,
    rawHtml,
    automated,
  };
  if (candidate && authorised) return appendToTicket(candidate, client, base);
  if (candidate && !authorised) {
    // Never disclose the referenced ticket: a fresh ticket flagged for review, linked for the agent.
    const reason = strong
      ? `Reply headers match ${ticketReference(candidate.number)} but the sender is not a participant`
      : `${weakReason} but the sender is not a participant`;
    const id = await createFromMessage(client, base, {
      review: reason,
      relatedTo: candidate.id,
    });
    return {
      action: "review",
      ticketId: id,
      reason,
      automated: automated.kind,
    };
  }
  if (automated.kind) {
    // Auto-replies with nothing to attach to: keep but never acknowledge.
    const id = await createFromMessage(client, base, {
      review: `Automated message (${automated.reason}) that matched no ticket`,
      noAck: true,
    });
    return {
      action: "review",
      ticketId: id,
      reason: automated.reason ?? undefined,
      automated: automated.kind,
    };
  }
  const id = await createFromMessage(client, base, {});
  return { action: "created", ticketId: id, automated: null };
}

type InboundBase = {
  msg: GraphMessage;
  m: Mailbox;
  externalId: string;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: { name: string | null; email: string } | null;
  fromEmail: string | null;
  newText: string;
  quoted: string | null;
  rawHtml: string | null;
  automated: ReturnType<typeof classifyAutomated>;
};

async function messageValues(
  b: InboundBase,
  ticketId: string,
  kind: "public" | "internal",
  direction: "inbound" | "outbound",
) {
  const sanitized = b.rawHtml
    ? sanitizeEmailHtml(b.rawHtml, { resolveCid: (cid) => `cid:${cid}` })
    : null;
  return {
    ticketId,
    kind,
    channel: "email" as const,
    direction,
    at: new Date(b.msg.receivedDateTime ?? b.msg.sentDateTime ?? Date.now()),
    fromName: b.from?.name ?? null,
    fromEmail: b.fromEmail,
    toRecipients: recipients(b.msg.toRecipients),
    ccRecipients: recipients(b.msg.ccRecipients),
    subject: b.subject,
    bodyText: b.newText,
    bodyHtml: sanitized?.html ?? null,
    quotedText: b.quoted,
    isAutomated: Boolean(b.automated.kind),
    automatedReason: b.automated.reason,
    mailboxId: b.m.id,
    externalMessageId: b.externalId,
    internetMessageId: b.internetMessageId,
    inReplyTo: b.inReplyTo,
    references: b.references,
    conversationId: b.msg.conversationId ?? null,
    deliveryStatus: "not_applicable" as const,
    metadata: {
      blockedImages: sanitized?.blockedImages ?? 0,
      hasAttachments: Boolean(b.msg.hasAttachments),
    },
  };
}

async function storeInboundAttachments(
  client: M365Client,
  b: InboundBase,
  ticketId: string,
  messageId: string,
) {
  if (!b.msg.hasAttachments) return { stored: 0, blocked: 0, errors: 0 };
  let stored = 0;
  let blocked = 0;
  let errors = 0;
  let list;
  try {
    list = await client.listAttachments(b.m.address, b.externalId);
  } catch (err) {
    await db.insert(ticketAttachments).values({
      ticketId,
      messageId,
      fileName: "(attachments)",
      scanStatus: "error",
      scanDetail: `Could not list attachments: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { stored, blocked, errors: 1 };
  }
  for (const a of list) {
    const size = a.size ?? 0;
    const policy = checkAttachmentPolicy(a.name, size);
    if (policy) {
      await db.insert(ticketAttachments).values({
        ticketId,
        messageId,
        fileName: a.name,
        contentType: a.contentType ?? "application/octet-stream",
        sizeBytes: size,
        inline: Boolean(a.isInline),
        contentId: a.contentId ?? null,
        scanStatus: "blocked",
        scanDetail: policy,
        externalAttachmentId: a.id,
      });
      blocked++;
      continue;
    }
    try {
      const bytes = await client.getAttachmentBytes(
        b.m.address,
        b.externalId,
        a.id,
      );
      if (!bytes) {
        await db.insert(ticketAttachments).values({
          ticketId,
          messageId,
          fileName: a.name,
          contentType: a.contentType ?? "application/octet-stream",
          sizeBytes: size,
          inline: Boolean(a.isInline),
          contentId: a.contentId ?? null,
          scanStatus: "error",
          scanDetail:
            "attachment has no downloadable content (item or reference attachment)",
          externalAttachmentId: a.id,
        });
        errors++;
        continue;
      }
      const id = randomUUID();
      const rel = await storeAttachmentBytes(b.m.id, id, bytes);
      const scan = await scanBytes(bytes);
      await db.insert(ticketAttachments).values({
        id,
        ticketId,
        messageId,
        fileName: a.name,
        contentType: a.contentType ?? "application/octet-stream",
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        storagePath: rel,
        inline: Boolean(a.isInline),
        contentId: a.contentId ?? null,
        scanStatus: scan.status,
        scanDetail: scan.detail,
        externalAttachmentId: a.id,
      });
      stored++;
    } catch (err) {
      await db.insert(ticketAttachments).values({
        ticketId,
        messageId,
        fileName: a.name,
        contentType: a.contentType ?? "application/octet-stream",
        sizeBytes: size,
        inline: Boolean(a.isInline),
        contentId: a.contentId ?? null,
        scanStatus: "error",
        scanDetail: (err instanceof Error ? err.message : String(err)).slice(
          0,
          300,
        ),
        externalAttachmentId: a.id,
      });
      errors++;
    }
  }
  return { stored, blocked, errors };
}

async function appendToTicket(
  t: typeof tickets.$inferSelect,
  client: M365Client,
  b: InboundBase,
): Promise<InboundOutcome> {
  const fromMailbox = b.fromEmail === b.m.address;
  const staff =
    !fromMailbox && b.fromEmail
      ? (await staffEmails()).has(b.fromEmail)
      : false;
  const direction = fromMailbox ? "outbound" : "inbound";
  const now = new Date();
  // A human reply to a closed ticket outside the reopen window becomes a linked follow-up ticket.
  if (
    !b.automated.kind &&
    !fromMailbox &&
    !staff &&
    t.status === "closed" &&
    (b.m.closedReplyPolicy === "follow_up" ||
      (t.closedAt &&
        Date.now() - t.closedAt.getTime() > b.m.closedReopenDays * 86400000))
  ) {
    const id = await createFromMessage(client, b, {
      relatedTo: t.id,
      followUpOf: ticketReference(t.number),
    });
    return { action: "follow_up", ticketId: id, automated: null };
  }
  const messageId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ticketMessages)
      .values(await messageValues(b, t.id, "public", direction))
      .onConflictDoNothing({
        target: [ticketMessages.mailboxId, ticketMessages.externalMessageId],
      })
      .returning({ id: ticketMessages.id });
    if (!row) return null;
    const patch: Partial<typeof tickets.$inferInsert> = {
      lastActivityAt: now,
      updatedAt: now,
    };
    if (!b.automated.kind && !fromMailbox && !staff)
      patch.lastCustomerMessageAt = now;
    if (fromMailbox || staff) {
      patch.lastAgentMessageAt = now;
      if (!t.firstResponseAt && !b.automated.kind) patch.firstResponseAt = now;
    }
    // Participants: anyone new on the thread becomes a CC so later replies from them are authorised.
    if (b.fromEmail && !fromMailbox && !staff)
      await tx
        .insert(ticketParticipants)
        .values({
          ticketId: t.id,
          role: "cc",
          name: b.from?.name ?? null,
          email: b.fromEmail,
          normalizedEmail: b.fromEmail,
        })
        .onConflictDoNothing();
    for (const r of [
      ...recipients(b.msg.toRecipients),
      ...recipients(b.msg.ccRecipients),
    ])
      if (r.email !== b.m.address)
        await tx
          .insert(ticketParticipants)
          .values({
            ticketId: t.id,
            role: "cc",
            name: r.name,
            email: r.email,
            normalizedEmail: r.email,
          })
          .onConflictDoNothing();
    await tx.update(tickets).set(patch).where(eq(tickets.id, t.id));
    await recordEvent(
      t.id,
      "message",
      b.automated.kind
        ? `Automated e-mail received (${b.automated.reason})`
        : fromMailbox
          ? "Reply sent from the mailbox"
          : `E-mail received from ${b.fromEmail}`,
      EMAIL_ACTOR,
      { messageId: row.id, automated: b.automated.kind },
      tx,
    );
    return row.id;
  });
  if (!messageId) return { action: "duplicate", ticketId: t.id };
  const att = await storeInboundAttachments(client, b, t.id, messageId);
  if (att.blocked || att.errors)
    await recordEvent(
      t.id,
      "attachment",
      `${att.stored} attachment${att.stored === 1 ? "" : "s"} stored, ${att.blocked} blocked, ${att.errors} failed`,
      EMAIL_ACTOR,
      att,
    );
  // Status effects of a human customer reply.
  if (!b.automated.kind && !fromMailbox && !staff) {
    if (
      t.status === "resolved" ||
      t.status === "closed" ||
      t.status === "cancelled"
    )
      await changeStatus(t.id, "open", EMAIL_ACTOR, {
        reason: "customer replied",
      });
    else if (t.status === "awaiting_customer")
      await changeStatus(t.id, "open", EMAIL_ACTOR, {
        reason: "customer replied",
      });
    if (t.companyId)
      await logActivity({
        type: "ticket",
        companyId: t.companyId,
        contactId: t.requesterContactId,
        entityType: "ticket",
        entityId: t.id,
        title: `Ticket ${ticketReference(t.number)}: reply from ${b.fromEmail}`,
        body: b.newText.slice(0, 300),
        source: "helpdesk-email",
      });
    await notifyUsers(await ticketAudience(t.id), {
      kind: "customer_replied",
      title: `${ticketReference(t.number)}: reply from ${b.from?.name ?? b.fromEmail}`,
      body: b.newText.slice(0, 300),
      ticketId: t.id,
      messageId,
    });
    await afterTicketChange(
      t.id,
      "customer_replied",
      EMAIL_ACTOR,
      "customer replied",
    );
  } else if (!b.automated.kind && (fromMailbox || staff))
    await afterTicketChange(
      t.id,
      "agent_replied",
      EMAIL_ACTOR,
      "reply sent from the mailbox",
    );
  return { action: "appended", ticketId: t.id, automated: b.automated.kind };
}

async function createFromMessage(
  client: M365Client,
  b: InboundBase,
  opts: {
    review?: string;
    relatedTo?: string | null;
    followUpOf?: string | null;
    noAck?: boolean;
  },
) {
  const reviewReason =
    opts.review ??
    (b.fromEmail &&
    b.m.unknownSenderPolicy === "review" &&
    !(await isKnownSender(b.fromEmail))
      ? "Sender is not a known contact"
      : null);
  const values = await messageValues(
    b,
    "00000000-0000-0000-0000-000000000000",
    "public",
    "inbound",
  );
  const id = await createTicket(
    {
      subject: opts.followUpOf
        ? `Follow-up to ${opts.followUpOf}: ${b.subject}`
        : b.subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, "") || b.subject,
      description: null,
      priority: "normal",
      type: "incident",
      categoryId: null,
      subcategoryId: null,
      tags: [],
      requesterContactId: null,
      requesterName: b.from?.name ?? null,
      requesterEmail: b.fromEmail,
      companyId: null,
      assigneeUserId: null,
      teamId: null,
      customFields: {},
    },
    EMAIL_ACTOR,
    {
      source: "email",
      initialMessage: (({ ticketId, ...rest }) => {
        void ticketId;
        return rest;
      })(values),
      needsReview: reviewReason,
    },
  );
  await db.update(tickets).set({ mailboxId: b.m.id }).where(eq(tickets.id, id));
  const [msgRow] = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(eq(ticketMessages.ticketId, id))
    .limit(1);
  if (msgRow) {
    const att = await storeInboundAttachments(client, b, id, msgRow.id);
    if (att.blocked || att.errors)
      await recordEvent(
        id,
        "attachment",
        `${att.stored} attachment${att.stored === 1 ? "" : "s"} stored, ${att.blocked} blocked, ${att.errors} failed`,
        EMAIL_ACTOR,
        att,
      );
  }
  // CC recipients on the original mail become participants.
  for (const r of recipients(b.msg.ccRecipients))
    if (r.email !== b.m.address && r.email !== b.fromEmail)
      await db
        .insert(ticketParticipants)
        .values({
          ticketId: id,
          role: "cc",
          name: r.name,
          email: r.email,
          normalizedEmail: r.email,
        })
        .onConflictDoNothing();
  if (opts.relatedTo) {
    const { ticketLinks } = await import("@/db/schema");
    await db
      .insert(ticketLinks)
      .values({
        ticketId: id,
        relatedTicketId: opts.relatedTo,
        kind: "related",
      })
      .onConflictDoNothing();
    await recordEvent(
      id,
      "link",
      `Possibly related to an existing ticket; review before merging`,
      EMAIL_ACTOR,
      { relatedTo: opts.relatedTo },
    );
  }
  if (
    !opts.noAck &&
    !b.automated.kind &&
    !opts.review &&
    b.fromEmail &&
    b.fromEmail !== b.m.address
  )
    await queueAcknowledgement(
      b.m,
      id,
      b.fromEmail,
      b.from?.name ?? null,
      b.subject,
    );
  return id;
}

async function isKnownSender(email: string) {
  const { contacts } = await import("@/db/schema");
  const [c] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.normalizedEmail, normalizeEmail(email)!),
        isNull(contacts.archivedAt),
      ),
    )
    .limit(1);
  return Boolean(c);
}

function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? "");
}

/** One acknowledgement per ticket, never to automated senders, and never more than a few per sender per hour (loop guard). */
async function queueAcknowledgement(
  m: Mailbox,
  ticketId: string,
  toEmail: string,
  toName: string | null,
  subject: string,
) {
  if (!m.ackEnabled) return null;
  const [t] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!t || t.ackSentAt) return null;
  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)`.mapWith(Number) })
    .from(mailboxOutbox)
    .where(
      and(
        eq(mailboxOutbox.mailboxId, m.id),
        eq(mailboxOutbox.kind, "ack"),
        eq(mailboxOutbox.toSummary, toEmail),
        sql`${mailboxOutbox.createdAt} > now() - interval '1 hour'`,
      ),
    );
  if (recent >= ACK_RATE_LIMIT_PER_HOUR) {
    await recordEvent(
      ticketId,
      "system",
      `Acknowledgement suppressed: ${recent} already sent to ${toEmail} in the last hour (loop guard)`,
      EMAIL_ACTOR,
    );
    return null;
  }
  const vars = {
    reference: ticketReference(t.number),
    subject,
    requester: toName ?? toEmail,
    signature: m.signature,
  };
  const body = fillTemplate(m.ackBody, vars);
  const result = await queueOutbound({
    mailbox: m,
    ticketId,
    kind: "ack",
    subject: fillTemplate(m.ackSubject, vars),
    markdown: body,
    to: [{ name: toName, email: toEmail }],
    cc: [],
    bcc: [],
    replyToMessageId: null,
    attachmentIds: [],
    actor: EMAIL_ACTOR,
    isAutomated: true,
    appendSignature: false,
  });
  await db
    .update(tickets)
    .set({ ackSentAt: new Date() })
    .where(eq(tickets.id, ticketId));
  return result;
}

// ---------------------------------------------------------------------------
// Outbound: transactional outbox
// ---------------------------------------------------------------------------
export type QueueOutboundInput = {
  mailbox: Mailbox;
  ticketId: string | null;
  kind: "ack" | "reply" | "new" | "test";
  subject: string;
  markdown: string;
  to: { name?: string | null; email: string }[];
  cc: { name?: string | null; email: string }[];
  bcc: { name?: string | null; email: string }[];
  replyToMessageId: string | null;
  attachmentIds: string[];
  actor: Actor & { name?: string; email?: string };
  isAutomated?: boolean;
  appendSignature?: boolean;
  idempotencyKey?: string;
};

/** Records the message and an outbox row in one transaction, then tries to send straight away. Repeated calls with the same idempotency key reuse the row. */
export async function queueOutbound(input: QueueOutboundInput) {
  const key = input.idempotencyKey ?? randomUUID();
  const [existing] = await db
    .select({
      id: mailboxOutbox.id,
      messageId: mailboxOutbox.messageId,
      status: mailboxOutbox.status,
    })
    .from(mailboxOutbox)
    .where(eq(mailboxOutbox.idempotencyKey, key))
    .limit(1);
  if (existing)
    return {
      outboxId: existing.id,
      messageId: existing.messageId,
      reused: true,
    };
  const markdown =
    input.appendSignature !== false &&
    input.mailbox.signature &&
    !input.isAutomated
      ? `${input.markdown.trim()}\n\n${input.mailbox.signature}`
      : input.markdown;
  const html = markdownToHtml(markdown);
  const text = markdownToPlainText(markdown);
  const replyTo = input.replyToMessageId
    ? (
        await db
          .select()
          .from(ticketMessages)
          .where(eq(ticketMessages.id, input.replyToMessageId))
          .limit(1)
      )[0]
    : null;
  const now = new Date();
  const ids = await db.transaction(async (tx) => {
    let messageId: string | null = null;
    if (input.ticketId) {
      const [row] = await tx
        .insert(ticketMessages)
        .values({
          ticketId: input.ticketId,
          kind: "public",
          channel: "email",
          direction: "outbound",
          at: now,
          authorUserId: input.actor.id,
          fromName: input.mailbox.displayName ?? input.mailbox.address,
          fromEmail: input.mailbox.address,
          toRecipients: input.to.map((r) => ({
            name: r.name ?? null,
            email: r.email,
          })),
          ccRecipients: input.cc.map((r) => ({
            name: r.name ?? null,
            email: r.email,
          })),
          bccRecipients: input.bcc.map((r) => ({
            name: r.name ?? null,
            email: r.email,
          })),
          subject: input.subject,
          bodyMarkdown: markdown,
          bodyText: text,
          bodyHtml: html,
          isAutomated: Boolean(input.isAutomated),
          automatedReason: input.isAutomated ? input.kind : null,
          mailboxId: input.mailbox.id,
          inReplyTo: replyTo?.internetMessageId ?? null,
          references: replyTo
            ? [
                ...replyTo.references,
                ...(replyTo.internetMessageId
                  ? [replyTo.internetMessageId]
                  : []),
              ]
            : [],
          conversationId: replyTo?.conversationId ?? null,
          deliveryStatus: "queued",
          replyToMessageId: input.replyToMessageId,
          metadata: { kind: input.kind },
        })
        .returning({ id: ticketMessages.id });
      messageId = row.id;
      if (input.attachmentIds.length)
        await tx
          .update(ticketAttachments)
          .set({ messageId, ticketId: input.ticketId })
          .where(inArray(ticketAttachments.id, input.attachmentIds));
    }
    const [ob] = await tx
      .insert(mailboxOutbox)
      .values({
        mailboxId: input.mailbox.id,
        ticketId: input.ticketId,
        messageId,
        idempotencyKey: key,
        kind: input.kind,
        status: "queued",
        replyToExternalId: replyTo?.externalMessageId ?? null,
        replyAll: false,
        toSummary: input.to.map((r) => r.email).join(", "),
        createdByUserId: input.actor.id,
      })
      .onConflictDoNothing({ target: mailboxOutbox.idempotencyKey })
      .returning({ id: mailboxOutbox.id });
    if (!ob) throw new ActionError("This message is already being sent.");
    if (input.ticketId)
      await recordEvent(
        input.ticketId,
        input.isAutomated ? "system" : "message",
        input.isAutomated
          ? `Acknowledgement queued to ${input.to.map((r) => r.email).join(", ")}`
          : `E-mail queued to ${input.to.map((r) => r.email).join(", ")}`,
        input.actor,
        { outboxId: ob.id },
        tx,
      );
    return { outboxId: ob.id, messageId };
  });
  // Best effort immediate send; the worker retries anything that fails here.
  await sendOutboxRow(ids.outboxId).catch((err) =>
    logger.warn(
      { err: String(err) },
      "immediate send failed; worker will retry",
    ),
  );
  return { ...ids, reused: false };
}

export async function processOutbox(limit = 25) {
  const rows = await db
    .select({ id: mailboxOutbox.id })
    .from(mailboxOutbox)
    .where(
      and(
        inArray(mailboxOutbox.status, ["queued", "unknown"]),
        lte(mailboxOutbox.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(asc(mailboxOutbox.createdAt))
    .limit(limit);
  let accepted = 0;
  let failed = 0;
  for (const r of rows) {
    const s = await sendOutboxRow(r.id).catch(() => "failed" as const);
    if (s === "accepted") accepted++;
    else if (s === "failed") failed++;
  }
  return { attempted: rows.length, accepted, failed };
}

/** Sends one outbox row. Idempotent: a second caller sees `submitting` and backs off; a provider id recorded before the send call allows reconciliation after a timeout. */
export async function sendOutboxRow(
  outboxId: string,
): Promise<"accepted" | "failed" | "unknown" | "skipped"> {
  // Claim.
  const [claimed] = await db
    .update(mailboxOutbox)
    .set({
      status: "submitting",
      attempts: sql`${mailboxOutbox.attempts} + 1`,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailboxOutbox.id, outboxId),
        inArray(mailboxOutbox.status, ["queued", "unknown"]),
      ),
    )
    .returning();
  if (!claimed) return "skipped";
  const m = await getMailbox(claimed.mailboxId);
  const resolved = m ? await clientForMailbox(m) : null;
  if (!m || !resolved)
    return markFailed(claimed, "mailbox not connected", true);
  const message = claimed.messageId
    ? (
        await db
          .select()
          .from(ticketMessages)
          .where(eq(ticketMessages.id, claimed.messageId))
          .limit(1)
      )[0]
    : null;
  if (claimed.messageId)
    await db
      .update(ticketMessages)
      .set({ deliveryStatus: "submitting" })
      .where(eq(ticketMessages.id, claimed.messageId));
  try {
    // Reconcile first when a previous attempt got as far as creating the draft.
    if (claimed.providerMessageId) {
      const existing = await resolved.client.getMessage(
        m.address,
        claimed.providerMessageId,
      );
      if (existing && existing.isDraft === false)
        return markAccepted(
          claimed,
          m,
          existing.internetMessageId ?? null,
          existing.id,
        );
      if (existing && existing.isDraft) {
        await resolved.client.sendDraft(m.address, claimed.providerMessageId);
        const after = await resolved.client.getMessage(
          m.address,
          claimed.providerMessageId,
        );
        return markAccepted(
          claimed,
          m,
          after?.internetMessageId ?? null,
          claimed.providerMessageId,
        );
      }
      // Draft vanished before sending: safe to build a fresh one.
    }
    const draft = await buildDraft(m, claimed, message);
    const created = await resolved.client.createDraft(
      m.address,
      draft,
      claimed.replyToExternalId,
      claimed.replyAll,
    );
    await db
      .update(mailboxOutbox)
      .set({ providerMessageId: created.id, updatedAt: new Date() })
      .where(eq(mailboxOutbox.id, claimed.id));
    try {
      await resolved.client.sendDraft(m.address, created.id);
    } catch (err) {
      // Microsoft may have accepted the send even though we did not hear back: never resend blindly.
      const msg = describeError(err);
      if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(msg))
        return markUnknown(claimed, msg);
      throw err;
    }
    const sent = await resolved.client
      .getMessage(m.address, created.id)
      .catch(() => null);
    return markAccepted(
      claimed,
      m,
      sent?.internetMessageId ?? null,
      created.id,
    );
  } catch (err) {
    // describeError carries Graph's own code and message, which is what an admin needs on the outbox row.
    const msg = describeError(err);
    const auth = /401|403|InvalidAuthenticationToken|ErrorAccessDenied/i.test(
      msg,
    );
    if (auth)
      await db
        .update(helpdeskMailboxes)
        .set({ status: "expired", lastError: msg.slice(0, 500) })
        .where(eq(helpdeskMailboxes.id, m.id));
    return markFailed(
      claimed,
      msg,
      auth || claimed.attempts >= MAX_OUTBOUND_ATTEMPTS,
    );
  }
}

async function buildDraft(
  m: Mailbox,
  ob: typeof mailboxOutbox.$inferSelect,
  message: typeof ticketMessages.$inferSelect | null,
): Promise<OutboundDraft> {
  const attachments: OutboundDraft["attachments"] = [];
  if (message) {
    const rows = await db
      .select()
      .from(ticketAttachments)
      .where(
        and(
          eq(ticketAttachments.messageId, message.id),
          eq(ticketAttachments.restricted, false),
        ),
      );
    for (const a of rows) {
      if (
        !a.storagePath ||
        a.scanStatus === "blocked" ||
        a.scanStatus === "error"
      )
        continue;
      attachments.push({
        name: a.fileName,
        contentType: a.contentType,
        bytes: await readAttachmentBytes(a.storagePath),
        contentId: a.contentId,
        inline: a.inline,
      });
    }
  }
  const headers: Record<string, string> = { "X-CRM-Outbox": ob.id };
  if (ob.ticketId) {
    const [t] = await db
      .select({ number: tickets.number })
      .from(tickets)
      .where(eq(tickets.id, ob.ticketId))
      .limit(1);
    if (t) headers["X-CRM-Ticket"] = ticketReference(t.number);
  }
  if (ob.kind === "ack" || message?.isAutomated) {
    headers["X-Auto-Response-Suppress"] = "All";
    headers["X-CRM-Automated"] = ob.kind;
  }
  if (ob.kind === "test")
    return {
      subject: "CRM helpdesk test message",
      html: markdownToHtml(
        `This is a test from the CRM helpdesk mailbox **${m.address}**. If you can read this, outbound mail works.`,
      ),
      text: `This is a test from the CRM helpdesk mailbox ${m.address}.`,
      to: (ob.toSummary ?? "")
        .split(",")
        .map((e) => ({ email: e.trim() }))
        .filter((r) => r.email),
      cc: [],
      bcc: [],
      headers,
      attachments,
    };
  if (!message) throw new Error("outbox row has no message");
  return {
    subject: message.subject ?? "",
    html:
      message.bodyHtml ??
      markdownToHtml(message.bodyMarkdown ?? message.bodyText),
    text: message.bodyText,
    to: message.toRecipients,
    cc: message.ccRecipients,
    bcc: message.bccRecipients,
    headers,
    attachments,
  };
}

async function markAccepted(
  ob: typeof mailboxOutbox.$inferSelect,
  m: Mailbox,
  internetMessageId: string | null,
  providerId: string,
) {
  const now = new Date();
  await db
    .update(mailboxOutbox)
    .set({
      status: "accepted",
      acceptedAt: now,
      providerMessageId: providerId,
      internetMessageId: normalizeMessageId(internetMessageId),
      lastError: null,
      updatedAt: now,
    })
    .where(eq(mailboxOutbox.id, ob.id));
  if (ob.messageId)
    await db
      .update(ticketMessages)
      .set({
        deliveryStatus: "accepted",
        deliveryDetail:
          "Accepted by Microsoft 365 (delivery to the recipient is not confirmed)",
        externalMessageId: providerId,
        internetMessageId: normalizeMessageId(internetMessageId),
      })
      .where(eq(ticketMessages.id, ob.messageId));
  await db
    .update(helpdeskMailboxes)
    .set({ lastOutboundAcceptedAt: now, status: "connected", lastError: null })
    .where(eq(helpdeskMailboxes.id, m.id));
  if (ob.ticketId) {
    const [t] = await db
      .select({
        firstResponseAt: tickets.firstResponseAt,
        companyId: tickets.companyId,
        number: tickets.number,
        requesterContactId: tickets.requesterContactId,
        subject: tickets.subject,
      })
      .from(tickets)
      .where(eq(tickets.id, ob.ticketId))
      .limit(1);
    const patch: Partial<typeof tickets.$inferInsert> = {
      lastAgentMessageAt: now,
      lastActivityAt: now,
    };
    if (t && !t.firstResponseAt && ob.kind !== "ack")
      patch.firstResponseAt = now;
    await db.update(tickets).set(patch).where(eq(tickets.id, ob.ticketId));
    if (t?.companyId && ob.kind !== "ack")
      await logActivity({
        type: "ticket",
        companyId: t.companyId,
        contactId: t.requesterContactId,
        entityType: "ticket_message",
        entityId: ob.messageId ?? ob.id,
        title: `Ticket ${ticketReference(t.number)}: e-mail sent to ${ob.toSummary ?? ""}`,
        actorUserId: ob.createdByUserId,
        source: "helpdesk-email",
      });
    if (ob.kind !== "ack")
      await afterTicketChange(
        ob.ticketId,
        "agent_replied",
        { id: ob.createdByUserId, type: "user" },
        "reply accepted by Microsoft 365",
      );
  }
  return "accepted" as const;
}
async function markUnknown(
  ob: typeof mailboxOutbox.$inferSelect,
  error: string,
) {
  await db
    .update(mailboxOutbox)
    .set({
      status: "unknown",
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    })
    .where(eq(mailboxOutbox.id, ob.id));
  if (ob.messageId)
    await db
      .update(ticketMessages)
      .set({
        deliveryStatus: "unknown",
        deliveryDetail:
          "Send timed out; checking with Microsoft 365 before trying again",
      })
      .where(eq(ticketMessages.id, ob.messageId));
  return "unknown" as const;
}
async function markFailed(
  ob: typeof mailboxOutbox.$inferSelect,
  error: string,
  final: boolean,
) {
  const backoff = Math.min(3600_000, 30_000 * 2 ** Math.min(ob.attempts, 6));
  await db
    .update(mailboxOutbox)
    .set({
      status: final ? "failed" : "queued",
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + backoff),
      updatedAt: new Date(),
    })
    .where(eq(mailboxOutbox.id, ob.id));
  if (ob.messageId)
    await db
      .update(ticketMessages)
      .set({
        deliveryStatus: final ? "failed" : "queued",
        deliveryDetail: final
          ? `Failed: ${error.slice(0, 200)}`
          : `Retrying: ${error.slice(0, 200)}`,
      })
      .where(eq(ticketMessages.id, ob.messageId));
  if (final && ob.ticketId) {
    await recordEvent(
      ob.ticketId,
      "system",
      `E-mail could not be sent: ${error.slice(0, 200)}`,
      { id: null, type: "system" },
    );
    await db
      .update(tickets)
      .set({
        needsReview: true,
        reviewReason:
          "An outgoing e-mail failed; the customer has not received it.",
      })
      .where(eq(tickets.id, ob.ticketId));
  }
  return "failed" as const;
}

// ---------------------------------------------------------------------------
// Agent-facing helpers
// ---------------------------------------------------------------------------
/** Sends a reply on a ticket from the mailbox (public, e-mailed). */
export async function sendTicketReply(
  ticketId: string,
  input: {
    markdown: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyToMessageId: string | null;
    attachmentIds: string[];
    idempotencyKey?: string;
    status?: string | null;
    version?: number;
  },
  actor: Actor & { name?: string; email?: string },
) {
  const m = await getDefaultMailbox();
  if (!m || (!mailboxIsLive(m) && process.env.DEMO_MODE !== "true"))
    throw new ActionError(
      "No support mailbox is connected. Connect one under Helpdesk → Administration → Mailbox.",
    );
  const t = await surviving(ticketId);
  if (!t || t.id !== ticketId)
    throw new ActionError(
      "This ticket was merged; reply on the surviving ticket.",
    );
  const to = input.to.length
    ? input.to
    : t.requesterEmail
      ? [t.requesterEmail]
      : [];
  if (to.length === 0)
    throw new ActionError("Add at least one recipient.", { to: ["Required"] });
  const bad = [...to, ...input.cc, ...input.bcc].find(
    (e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e),
  );
  if (bad) throw new ActionError(`"${bad}" is not a valid e-mail address.`);
  // Reply to the latest inbound message unless one was chosen, to keep threading headers.
  let replyToMessageId = input.replyToMessageId;
  if (!replyToMessageId) {
    const [last] = await db
      .select({ id: ticketMessages.id })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.channel, "email"),
          sql`${ticketMessages.externalMessageId} is not null`,
        ),
      )
      .orderBy(desc(ticketMessages.at))
      .limit(1);
    replyToMessageId = last?.id ?? null;
  }
  const ref = ticketReference(t.number);
  const subject = t.subject.includes(ref)
    ? t.subject.startsWith("Re:")
      ? t.subject
      : `Re: ${t.subject}`
    : `Re: [${ref}] ${t.subject}`;
  if (input.version) {
    const [cur] = await db
      .select({ version: tickets.version })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (cur && cur.version !== input.version)
      throw new ActionError(
        "Someone else changed this ticket while you were writing. Reload and check the conversation before sending.",
      );
  }
  const result = await queueOutbound({
    mailbox: m,
    ticketId,
    kind: "reply",
    subject,
    markdown: input.markdown,
    to: to.map((email) => ({ email })),
    cc: input.cc.map((email) => ({ email })),
    bcc: input.bcc.map((email) => ({ email })),
    replyToMessageId,
    attachmentIds: input.attachmentIds,
    actor,
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.reused) {
    await db
      .update(tickets)
      .set({
        version: sql`${tickets.version} + 1`,
        status: t.status === "new" ? "open" : t.status,
      })
      .where(eq(tickets.id, ticketId));
    for (const email of [...to, ...input.cc])
      if (email !== t.requesterEmail && email !== m.address)
        await db
          .insert(ticketParticipants)
          .values({ ticketId, role: "cc", email, normalizedEmail: email })
          .onConflictDoNothing();
    if (input.status)
      await changeStatus(ticketId, input.status as "open", actor);
  }
  return result;
}

/** Composes a brand-new outbound e-mail and the ticket that tracks it. */
export async function composeNewEmail(
  input: {
    subject: string;
    markdown: string;
    to: string[];
    cc: string[];
    bcc: string[];
    companyId: string | null;
    contactId: string | null;
    attachmentIds: string[];
    idempotencyKey?: string;
  },
  actor: Actor & { name?: string; email?: string },
) {
  const m = await getDefaultMailbox();
  if (!m || (!mailboxIsLive(m) && process.env.DEMO_MODE !== "true"))
    throw new ActionError("No support mailbox is connected.");
  if (input.to.length === 0)
    throw new ActionError("Add at least one recipient.", { to: ["Required"] });
  const ticketId = await createTicket(
    {
      subject: input.subject,
      description: null,
      priority: "normal",
      type: "service_request",
      categoryId: null,
      subcategoryId: null,
      tags: [],
      requesterContactId: input.contactId,
      requesterName: null,
      requesterEmail: input.contactId ? null : input.to[0],
      companyId: input.companyId,
      assigneeUserId: actor.id,
      teamId: null,
      customFields: {},
    },
    actor,
    { source: "manual" },
  );
  await db
    .update(tickets)
    .set({ mailboxId: m.id, status: "awaiting_customer" })
    .where(eq(tickets.id, ticketId));
  const ref = ticketReference(
    (
      await db
        .select({ number: tickets.number })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1)
    )[0].number,
  );
  const result = await queueOutbound({
    mailbox: m,
    ticketId,
    kind: "new",
    subject: `[${ref}] ${input.subject}`,
    markdown: input.markdown,
    to: input.to.map((email) => ({ email })),
    cc: input.cc.map((email) => ({ email })),
    bcc: input.bcc.map((email) => ({ email })),
    replyToMessageId: null,
    attachmentIds: input.attachmentIds,
    actor,
    idempotencyKey: input.idempotencyKey,
  });
  for (const email of [...input.to.slice(1), ...input.cc])
    await db
      .insert(ticketParticipants)
      .values({ ticketId, role: "cc", email, normalizedEmail: email })
      .onConflictDoNothing();
  return { ticketId, ...result };
}

/** Controlled test: only to an active staff user's address. */
export async function sendTestEmail(
  mailboxId: string,
  toEmail: string,
  actorUserId: string,
) {
  const m = await getMailbox(mailboxId);
  if (!m) throw new ActionError("Mailbox not found.");
  const norm = normalizeEmail(toEmail);
  if (!norm || !(await staffEmails()).has(norm))
    throw new ActionError(
      "Test e-mails can only go to an active CRM user's address.",
    );
  const r = await queueOutbound({
    mailbox: m,
    ticketId: null,
    kind: "test",
    subject: "CRM helpdesk test message",
    markdown: "test",
    to: [{ email: norm }],
    cc: [],
    bcc: [],
    replyToMessageId: null,
    attachmentIds: [],
    actor: { id: actorUserId, type: "user" },
    appendSignature: false,
  });
  await audit({
    actorUserId,
    action: "mailbox.test_email",
    entityType: "helpdesk_mailbox",
    entityId: mailboxId,
    details: { to: norm },
  });
  const [row] = await db
    .select()
    .from(mailboxOutbox)
    .where(eq(mailboxOutbox.id, r.outboxId))
    .limit(1);
  return row;
}

/** Stores an agent upload before it is attached to a message (scanned like inbound mail). */
export async function storeUpload(
  ticketId: string,
  file: { name: string; type: string; bytes: Buffer },
  userId: string,
  restricted = false,
) {
  const policy = checkAttachmentPolicy(file.name, file.bytes.length);
  if (policy) throw new ActionError(`${file.name}: ${policy}`);
  const id = randomUUID();
  const rel = await storeAttachmentBytes(`uploads`, id, file.bytes);
  const scan = await scanBytes(file.bytes);
  if (scan.status === "blocked") {
    await db.insert(ticketAttachments).values({
      id,
      ticketId,
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.bytes.length,
      sha256: sha256(file.bytes),
      storagePath: rel,
      scanStatus: "blocked",
      scanDetail: scan.detail,
      uploadedByUserId: userId,
      restricted,
    });
    throw new ActionError(
      `${file.name} was blocked by the virus scanner (${scan.detail}).`,
    );
  }
  await db.insert(ticketAttachments).values({
    id,
    ticketId,
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.bytes.length,
    sha256: sha256(file.bytes),
    storagePath: rel,
    scanStatus: scan.status,
    scanDetail: scan.detail,
    uploadedByUserId: userId,
    restricted,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Admin views, replay tools, maintenance
// ---------------------------------------------------------------------------
export async function mailboxHealth() {
  const m = await getDefaultMailbox();
  if (!m) return null;
  const [q] = await db
    .select({
      pending: sql<number>`count(*) filter (where status = 'pending')`.mapWith(
        Number,
      ),
      processing:
        sql<number>`count(*) filter (where status = 'processing')`.mapWith(
          Number,
        ),
      failed: sql<number>`count(*) filter (where status = 'dead')`.mapWith(
        Number,
      ),
      done24h:
        sql<number>`count(*) filter (where status = 'done' and processed_at > now() - interval '24 hours')`.mapWith(
          Number,
        ),
      oldestPending: sql<Date | null>`min(received_at) filter (where status = 'pending')`,
    })
    .from(mailboxInboundQueue)
    .where(eq(mailboxInboundQueue.mailboxId, m.id));
  const [o] = await db
    .select({
      queued:
        sql<number>`count(*) filter (where status in ('queued','submitting'))`.mapWith(
          Number,
        ),
      unknown: sql<number>`count(*) filter (where status = 'unknown')`.mapWith(
        Number,
      ),
      failed: sql<number>`count(*) filter (where status = 'failed')`.mapWith(
        Number,
      ),
      accepted24h:
        sql<number>`count(*) filter (where status = 'accepted' and accepted_at > now() - interval '24 hours')`.mapWith(
          Number,
        ),
    })
    .from(mailboxOutbox)
    .where(eq(mailboxOutbox.mailboxId, m.id));
  const resolved = await clientForMailbox(m);
  const subscriptionState = !mailboxIsLive(m)
    ? resolved?.mode === "demo"
      ? "demo"
      : "not connected"
    : !m.subscriptionId
      ? "missing"
      : m.subscriptionError
        ? "error"
        : m.subscriptionExpiresAt &&
            m.subscriptionExpiresAt.getTime() < Date.now()
          ? "expired"
          : "active";
  const staleInbound = m.lastInboundSyncAt
    ? Date.now() - m.lastInboundSyncAt.getTime() > 20 * 60_000
    : true;
  return {
    mailbox: { ...m, credentialsEnc: undefined },
    mode: resolved?.mode ?? null,
    live: mailboxIsLive(m),
    queue: q,
    outbox: o,
    subscriptionState,
    staleInbound,
    credentialExpiringSoon: m.credentialExpiresAt
      ? m.credentialExpiresAt.getTime() - Date.now() < 30 * 86400000
      : false,
  };
}
export async function listInboundQueue(
  mailboxId: string,
  status?: string,
  limit = 50,
) {
  return db
    .select({
      q: mailboxInboundQueue,
      ticketNumber: tickets.number,
      ticketSubject: tickets.subject,
    })
    .from(mailboxInboundQueue)
    .leftJoin(tickets, eq(tickets.id, mailboxInboundQueue.ticketId))
    .where(
      and(
        eq(mailboxInboundQueue.mailboxId, mailboxId),
        status && status !== "all"
          ? eq(mailboxInboundQueue.status, status as "pending")
          : undefined,
      ),
    )
    .orderBy(desc(mailboxInboundQueue.receivedAt))
    .limit(limit)
    .then((rows) =>
      rows.map((r) => ({
        ...r.q,
        reference: r.ticketNumber ? ticketReference(r.ticketNumber) : null,
        ticketSubject: r.ticketSubject,
      })),
    );
}
export async function listOutbox(
  mailboxId: string,
  status?: string,
  limit = 50,
) {
  return db
    .select({
      o: mailboxOutbox,
      ticketNumber: tickets.number,
      ticketSubject: tickets.subject,
      createdBy: user.name,
    })
    .from(mailboxOutbox)
    .leftJoin(tickets, eq(tickets.id, mailboxOutbox.ticketId))
    .leftJoin(user, eq(user.id, mailboxOutbox.createdByUserId))
    .where(
      and(
        eq(mailboxOutbox.mailboxId, mailboxId),
        status && status !== "all"
          ? eq(mailboxOutbox.status, status as "queued")
          : undefined,
      ),
    )
    .orderBy(desc(mailboxOutbox.createdAt))
    .limit(limit)
    .then((rows) =>
      rows.map((r) => ({
        ...r.o,
        reference: r.ticketNumber ? ticketReference(r.ticketNumber) : null,
        ticketSubject: r.ticketSubject,
        createdBy: r.createdBy,
      })),
    );
}
export async function replayInbound(queueId: string, actorUserId: string) {
  await db
    .update(mailboxInboundQueue)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      source: "replay",
    })
    .where(eq(mailboxInboundQueue.id, queueId));
  await audit({
    actorUserId,
    action: "mailbox.replay",
    entityType: "mailbox_inbound",
    entityId: queueId,
  });
  return processInboundRow(queueId);
}
/** Retries a failed or unknown row, or sends a queued row now instead of waiting out its backoff. */
export async function retryOutbox(outboxId: string, actorUserId: string) {
  await db
    .update(mailboxOutbox)
    .set({
      status: "queued",
      nextAttemptAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailboxOutbox.id, outboxId),
        inArray(mailboxOutbox.status, ["failed", "unknown", "queued"]),
      ),
    );
  await audit({
    actorUserId,
    action: "mailbox.retry_outbound",
    entityType: "mailbox_outbox",
    entityId: outboxId,
  });
  return sendOutboxRow(outboxId);
}
export async function cancelOutbox(outboxId: string, actorUserId: string) {
  const [ob] = await db
    .select()
    .from(mailboxOutbox)
    .where(eq(mailboxOutbox.id, outboxId))
    .limit(1);
  if (!ob || ob.status === "accepted")
    throw new ActionError(
      "This message was already accepted by Microsoft 365 and cannot be cancelled.",
    );
  await db
    .update(mailboxOutbox)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(mailboxOutbox.id, outboxId));
  if (ob.messageId)
    await db
      .update(ticketMessages)
      .set({
        deliveryStatus: "failed",
        deliveryDetail: "Cancelled by an administrator",
      })
      .where(eq(ticketMessages.id, ob.messageId));
  await audit({
    actorUserId,
    action: "mailbox.cancel_outbound",
    entityType: "mailbox_outbox",
    entityId: outboxId,
  });
}

/** Worker entry point: subscriptions, delta recovery, queue draining and outbox in one place. */
export async function mailboxTick(
  opts: { delta?: boolean; subscriptions?: boolean } = {},
) {
  const boxes = (await listMailboxes()).filter((m) => m.active);
  const out: Record<string, unknown> = {};
  for (const m of boxes) {
    const resolved = await clientForMailbox(m);
    if (!resolved) continue;
    if (opts.subscriptions)
      out[`${m.address}.subscription`] = await ensureSubscription(m);
    if (opts.delta || m.deltaLinks.__force)
      out[`${m.address}.delta`] = (await runDeltaSync(m))?.status ?? null;
  }
  out.inbound = await processInboundQueue();
  out.outbox = await processOutbox();
  return out;
}

export { ticketReference, companies };
