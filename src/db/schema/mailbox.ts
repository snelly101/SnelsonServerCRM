import { pgTable, text, timestamp, uuid, jsonb, pgEnum, index, uniqueIndex, integer, boolean } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { tickets, ticketMessages } from "./helpdesk";

// ---------------------------------------------------------------------------
// Helpdesk mailboxes (Phase 13, stage 2). One row per connected Microsoft 365
// mailbox (a user or shared mailbox). Credentials are encrypted like every
// other integration; the access token is cached inside the same blob.
// Inbound work is persisted in a queue before processing; outbound mail goes
// through a transactional outbox with honest states.
// ---------------------------------------------------------------------------
export const mailboxStatusEnum = pgEnum("mailbox_status", ["not_configured", "connected", "error", "expired", "disconnected"]);
export const inboundQueueStatusEnum = pgEnum("inbound_queue_status", ["pending", "processing", "done", "failed", "dead", "skipped"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["queued", "submitting", "accepted", "failed", "unknown", "cancelled"]);

export const helpdeskMailboxes = pgTable(
  "helpdesk_mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull(),
    displayName: text("display_name"),
    tenantId: text("tenant_id"),
    /** secret | certificate */
    authMode: text("auth_mode").notNull().default("secret"),
    credentialsEnc: text("credentials_enc"),
    /** Entered by the admin for display; Graph does not expose the app secret's expiry. */
    credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
    status: mailboxStatusEnum("status").notNull().default("not_configured"),
    lastError: text("last_error"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    /** Monitored folders: Graph ids and names. Only these are synced; rules moving mail elsewhere hide it from the helpdesk. */
    folders: jsonb("folders").$type<{ id: string; name: string }[]>().notNull().default([{ id: "inbox", name: "Inbox" }]),
    /** Import cutoff: mail received before this is never turned into tickets. */
    importFrom: timestamp("import_from", { withTimezone: true }),
    /** Delta links per folder id. */
    deltaLinks: jsonb("delta_links").$type<Record<string, string>>().notNull().default({}),
    subscriptionId: text("subscription_id"),
    subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
    subscriptionClientState: text("subscription_client_state"),
    subscriptionError: text("subscription_error"),
    lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
    lastInboundSyncAt: timestamp("last_inbound_sync_at", { withTimezone: true }),
    lastOutboundAcceptedAt: timestamp("last_outbound_accepted_at", { withTimezone: true }),
    // Behaviour
    ackEnabled: boolean("ack_enabled").notNull().default(true),
    ackSubject: text("ack_subject").notNull().default("[{{reference}}] We have received your request: {{subject}}"),
    ackBody: text("ack_body").notNull().default("Hello {{requester}},\n\nThanks for getting in touch. We have logged your request as **{{reference}}** and someone will be in touch shortly.\n\nPlease keep the reference in the subject line when you reply.\n\n{{signature}}"),
    /** create_unverified | review */
    unknownSenderPolicy: text("unknown_sender_policy").notNull().default("create_unverified"),
    /** reopen | follow_up */
    closedReplyPolicy: text("closed_reply_policy").notNull().default("reopen"),
    closedReopenDays: integer("closed_reopen_days").notNull().default(14),
    signature: text("signature").notNull().default("Kind regards,\nThe support team"),
    isDefault: boolean("is_default").notNull().default(true),
    active: boolean("active").notNull().default(true),
    connectedByUserId: text("connected_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("helpdesk_mailboxes_address_unique").on(t.address), index("helpdesk_mailboxes_subscription_idx").on(t.subscriptionId)],
);

export const mailboxInboundQueue = pgTable(
  "mailbox_inbound_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => helpdeskMailboxes.id, { onDelete: "cascade" }),
    /** Graph immutable message id. */
    externalMessageId: text("external_message_id").notNull(),
    /** notification | delta | manual | replay */
    source: text("source").notNull().default("notification"),
    status: inboundQueueStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    /** What processing decided (ticket id, action) for the admin queue view. */
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("mailbox_inbound_unique").on(t.mailboxId, t.externalMessageId), index("mailbox_inbound_status_idx").on(t.status, t.nextAttemptAt)],
);

export const mailboxOutbox = pgTable(
  "mailbox_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => helpdeskMailboxes.id, { onDelete: "cascade" }),
    /** Null only for a controlled test e-mail. */
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => ticketMessages.id, { onDelete: "cascade" }),
    /** ack | reply | new | test */
    toSummary: text("to_summary"),
    /** One row per logical send; repeated clicks reuse it. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** ack | reply | new | notification */
    kind: text("kind").notNull().default("reply"),
    status: outboxStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    /** Graph draft/message immutable id (same id after send). */
    providerMessageId: text("provider_message_id"),
    internetMessageId: text("internet_message_id"),
    /** Graph id of the message being replied to, for createReply threading. */
    replyToExternalId: text("reply_to_external_id"),
    replyAll: boolean("reply_all").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("mailbox_outbox_key_unique").on(t.idempotencyKey), index("mailbox_outbox_status_idx").on(t.status, t.nextAttemptAt), index("mailbox_outbox_ticket_idx").on(t.ticketId), index("mailbox_outbox_provider_idx").on(t.providerMessageId)],
);

import { timestamps } from "./core";
