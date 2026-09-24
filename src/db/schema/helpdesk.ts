import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  integer,
  boolean,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, contacts, timestamps } from "./core";

// ---------------------------------------------------------------------------
// Helpdesk core (Phase 13, stage 1). Tickets carry a readable reference
// IT-000123 derived from an identity column, a conversation of messages
// (customer-facing or internal), participants, attachments (metadata here,
// bytes on disk), an append-only event trail, links between tickets and
// time entries. Later stages add mailboxes, the outbox, SLA policies,
// automation rules, knowledge articles and assets in their own migrations.
// ---------------------------------------------------------------------------
export const ticketStatusEnum = pgEnum("ticket_status", [
  "new",
  "open",
  "in_progress",
  "awaiting_customer",
  "awaiting_third_party",
  "resolved",
  "closed",
  "cancelled",
]);
export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "low",
  "normal",
  "high",
  "critical",
]);
export const ticketTypeEnum = pgEnum("ticket_type", [
  "incident",
  "service_request",
  "problem",
  "change",
]);
export const ticketSourceEnum = pgEnum("ticket_source", [
  "email",
  "manual",
  "portal",
]);
export const ticketMessageKindEnum = pgEnum("ticket_message_kind", [
  "public",
  "internal",
]);
export const ticketMessageChannelEnum = pgEnum("ticket_message_channel", [
  "email",
  "manual",
  "note",
  "system",
]);
export const ticketMessageDirectionEnum = pgEnum("ticket_message_direction", [
  "inbound",
  "outbound",
  "internal",
]);
export const ticketParticipantRoleEnum = pgEnum("ticket_participant_role", [
  "requester",
  "cc",
  "follower",
]);
export const ticketLinkKindEnum = pgEnum("ticket_link_kind", [
  "related",
  "parent",
  "duplicate",
  "merged_from",
  "split_from",
]);
export const attachmentScanStatusEnum = pgEnum("attachment_scan_status", [
  "pending",
  "clean",
  "blocked",
  "skipped",
  "error",
]);
/** Outbound e-mail states (stage 2 fills these in; manual messages are `not_applicable`). */
export const messageDeliveryStatusEnum = pgEnum("message_delivery_status", [
  "not_applicable",
  "draft",
  "queued",
  "submitting",
  "accepted",
  "failed",
  "unknown",
  "bounced",
]);

export const helpdeskTeams = pgTable("helpdesk_teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const helpdeskTeamMembers = pgTable(
  "helpdesk_team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => helpdeskTeams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    isLead: boolean("is_lead").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const helpdeskCategories = pgTable(
  "helpdesk_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Null for a top-level category; set for a subcategory. */
    parentId: uuid("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("helpdesk_categories_parent_idx").on(t.parentId)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Sequential number; the readable reference is IT-<number padded to 6>. */
    number: integer("number").generatedAlwaysAsIdentity(),
    subject: text("subject").notNull(),
    /** The initial description for manual tickets; e-mail tickets keep it in the first message. */
    description: text("description"),
    status: ticketStatusEnum("status").notNull().default("new"),
    priority: ticketPriorityEnum("priority").notNull().default("normal"),
    type: ticketTypeEnum("type").notNull().default("incident"),
    source: ticketSourceEnum("source").notNull().default("manual"),
    categoryId: uuid("category_id").references(() => helpdeskCategories.id, {
      onDelete: "set null",
    }),
    subcategoryId: uuid("subcategory_id").references(
      () => helpdeskCategories.id,
      { onDelete: "set null" },
    ),
    tags: text("tags").array().notNull().default(sqlEmptyArray()),
    requesterName: text("requester_name"),
    requesterEmail: text("requester_email"),
    /** Lower-cased requester address, for matching. */
    requesterNormalizedEmail: text("requester_normalized_email"),
    requesterContactId: uuid("requester_contact_id").references(
      () => contacts.id,
      { onDelete: "set null" },
    ),
    /** True when the sender could not be matched to a CRM contact and nobody has confirmed them yet. */
    requesterUnverified: boolean("requester_unverified")
      .notNull()
      .default(false),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    assigneeUserId: text("assignee_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    teamId: uuid("team_id").references(() => helpdeskTeams.id, {
      onDelete: "set null",
    }),
    /** Set when an inbound e-mail could not be safely attached or its sender needs confirming. */
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastCustomerMessageAt: timestamp("last_customer_message_at", {
      withTimezone: true,
    }),
    lastAgentMessageAt: timestamp("last_agent_message_at", {
      withTimezone: true,
    }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reopenCount: integer("reopen_count").notNull().default(0),
    /** SLA (stage 3 adds the policy table; deadlines live here so lists can sort on them). */
    slaPolicyId: uuid("sla_policy_id"),
    firstResponseDueAt: timestamp("first_response_due_at", {
      withTimezone: true,
    }),
    resolutionDueAt: timestamp("resolution_due_at", { withTimezone: true }),
    firstResponseBreached: boolean("first_response_breached")
      .notNull()
      .default(false),
    resolutionBreached: boolean("resolution_breached").notNull().default(false),
    resolutionSummary: text("resolution_summary"),
    resolutionCategory: text("resolution_category"),
    mergedIntoTicketId: uuid("merged_into_ticket_id"),
    parentTicketId: uuid("parent_ticket_id"),
    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Optimistic concurrency: every write compares and bumps this. */
    version: integer("version").notNull().default(1),
    /** When the automatic acknowledgement went out (sent once per ticket). */
    ackSentAt: timestamp("ack_sent_at", { withTimezone: true }),
    /** Mailbox that owns this ticket's e-mail thread. */
    mailboxId: uuid("mailbox_id"),
    /** Denormalised total of time entries in minutes. */
    timeSpentMinutes: integer("time_spent_minutes").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tickets_number_unique").on(t.number),
    index("tickets_status_idx").on(t.status, t.priority),
    index("tickets_assignee_idx").on(t.assigneeUserId, t.status),
    index("tickets_team_idx").on(t.teamId, t.status),
    index("tickets_company_idx").on(t.companyId),
    index("tickets_contact_idx").on(t.requesterContactId),
    index("tickets_requester_email_idx").on(t.requesterNormalizedEmail),
    index("tickets_last_activity_idx").on(t.lastActivityAt),
    index("tickets_due_idx").on(t.firstResponseDueAt, t.resolutionDueAt),
    index("tickets_merged_idx").on(t.mergedIntoTicketId),
    index("tickets_parent_idx").on(t.parentTicketId),
  ],
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    kind: ticketMessageKindEnum("kind").notNull(),
    channel: ticketMessageChannelEnum("channel").notNull(),
    direction: ticketMessageDirectionEnum("direction").notNull(),
    /** When the message was sent/received (UTC). */
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    authorUserId: text("author_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    toRecipients: jsonb("to_recipients")
      .$type<{ name?: string | null; email: string }[]>()
      .notNull()
      .default([]),
    ccRecipients: jsonb("cc_recipients")
      .$type<{ name?: string | null; email: string }[]>()
      .notNull()
      .default([]),
    /** Outbound only; never rendered in customer-visible views or exports. */
    bccRecipients: jsonb("bcc_recipients")
      .$type<{ name?: string | null; email: string }[]>()
      .notNull()
      .default([]),
    subject: text("subject"),
    /** Plain text, always present (derived from HTML when the source had none). */
    bodyText: text("body_text").notNull().default(""),
    /** Sanitised HTML for display, or null when the message was plain text. */
    bodyHtml: text("body_html"),
    /** Markdown source for agent-authored messages. */
    bodyMarkdown: text("body_markdown"),
    /** Portion of the body that is quoted history or a signature, split off for collapsed display. */
    quotedText: text("quoted_text"),
    /** True for auto-replies, bounces, out-of-office and other machine-generated mail. */
    isAutomated: boolean("is_automated").notNull().default(false),
    automatedReason: text("automated_reason"),
    /** Stage 2: mailbox this message belongs to; every external identifier is scoped to it. */
    mailboxId: uuid("mailbox_id"),
    /** Provider (Graph) immutable id. */
    externalMessageId: text("external_message_id"),
    internetMessageId: text("internet_message_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references").array().notNull().default(sqlEmptyArray()),
    conversationId: text("conversation_id"),
    deliveryStatus: messageDeliveryStatusEnum("delivery_status")
      .notNull()
      .default("not_applicable"),
    deliveryDetail: text("delivery_detail"),
    /** Message this one replies to (for outbound threading). */
    replyToMessageId: uuid("reply_to_message_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    index("ticket_messages_ticket_idx").on(t.ticketId, t.at),
    uniqueIndex("ticket_messages_external_unique").on(
      t.mailboxId,
      t.externalMessageId,
    ),
    index("ticket_messages_internet_id_idx").on(
      t.mailboxId,
      t.internetMessageId,
    ),
    index("ticket_messages_conversation_idx").on(t.mailboxId, t.conversationId),
  ],
);

export const ticketParticipants = pgTable(
  "ticket_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    role: ticketParticipantRoleEnum("role").notNull(),
    name: text("name"),
    email: text("email"),
    normalizedEmail: text("normalized_email"),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** Staff followers. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ticket_participants_email_unique").on(
      t.ticketId,
      t.normalizedEmail,
    ),
    uniqueIndex("ticket_participants_user_unique").on(t.ticketId, t.userId),
    index("ticket_participants_ticket_idx").on(t.ticketId),
  ],
);

export const ticketAttachments = pgTable(
  "ticket_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => ticketMessages.id, {
      onDelete: "set null",
    }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type")
      .notNull()
      .default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    sha256: text("sha256"),
    /** Relative path under the attachment root; null when the bytes could not be stored (see scanDetail). */
    storagePath: text("storage_path"),
    inline: boolean("inline").notNull().default(false),
    contentId: text("content_id"),
    scanStatus: attachmentScanStatusEnum("scan_status")
      .notNull()
      .default("pending"),
    scanDetail: text("scan_detail"),
    /** Internal-only attachments never leave the CRM. */
    restricted: boolean("restricted").notNull().default(false),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Provider attachment id, for lazy download / retry. */
    externalAttachmentId: text("external_attachment_id"),
    ...timestamps,
  },
  (t) => [
    index("ticket_attachments_ticket_idx").on(t.ticketId),
    index("ticket_attachments_message_idx").on(t.messageId),
  ],
);

export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** user | system | automation | email */
    actorType: text("actor_type").notNull().default("user"),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** created, status, priority, type, assignee, team, category, tags, requester, company, merge, split, message, note, time, link, sla, field, attachment, reopen, resolve, close, automation */
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.at)],
);

export const ticketLinks = pgTable(
  "ticket_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    relatedTicketId: uuid("related_ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    kind: ticketLinkKindEnum("kind").notNull().default("related"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ticket_links_unique").on(
      t.ticketId,
      t.relatedTicketId,
      t.kind,
    ),
    index("ticket_links_related_idx").on(t.relatedTicketId),
  ],
);

export const ticketTimeEntries = pgTable(
  "ticket_time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    billable: boolean("billable").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("ticket_time_entries_ticket_idx").on(t.ticketId),
    index("ticket_time_entries_user_idx").on(t.userId),
  ],
);

/** Running timers: one per user per ticket, turned into a time entry on stop. */
export const ticketTimers = pgTable(
  "ticket_timers",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.userId] })],
);

/** Per-user draft of a reply or note, saved automatically. */
export const ticketDrafts = pgTable(
  "ticket_drafts",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: ticketMessageKindEnum("kind").notNull().default("public"),
    body: text("body").notNull().default(""),
    recipients: jsonb("recipients").$type<{
      to: string[];
      cc: string[];
      bcc: string[];
    }>(),
    /** Ticket version seen when the draft was last saved, to warn about concurrent edits. */
    ticketVersion: integer("ticket_version"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.userId] })],
);

import { sql } from "drizzle-orm";
function sqlEmptyArray() {
  return sql`'{}'::text[]`;
}
