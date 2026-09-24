import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  pgEnum,
  index,
  integer,
  boolean,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, timestamps } from "./core";
import { tickets, ticketMessages } from "./helpdesk";
import type { WeeklySchedule } from "@/lib/helpdesk/business-hours";

// ---------------------------------------------------------------------------
// Stage 3: SLA policies with business hours and holidays, an event history
// that makes every deadline explainable, automation rules with ordering and a
// run log, response templates, checklists, and in-app notifications.
// ---------------------------------------------------------------------------
export const slaTargetKindEnum = pgEnum("sla_target_kind", [
  "first_response",
  "resolution",
]);
export const slaEventKindEnum = pgEnum("sla_event_kind", [
  "start",
  "pause",
  "resume",
  "met",
  "breach",
  "reset",
  "policy_changed",
]);
export const automationTriggerEnum = pgEnum("automation_trigger", [
  "ticket_created",
  "ticket_updated",
  "customer_replied",
  "agent_replied",
  "status_changed",
  "sla_breached",
  "sla_due_soon",
  "schedule",
]);

export const helpdeskBusinessHours = pgTable("helpdesk_business_hours", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  timezone: text("timezone").notNull().default("Europe/London"),
  schedule: jsonb("schedule").$type<WeeklySchedule>().notNull(),
  /** ISO dates (local to the timezone). */
  holidays: jsonb("holidays").$type<string[]>().notNull().default([]),
  always: boolean("always").notNull().default(false),
  ...timestamps,
});

export const helpdeskSlaPolicies = pgTable("helpdesk_sla_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  businessHoursId: uuid("business_hours_id").references(
    () => helpdeskBusinessHours.id,
    { onDelete: "set null" },
  ),
  /** Minutes of business time per priority; null = no target. */
  firstResponseMinutes: jsonb("first_response_minutes")
    .$type<Record<string, number | null>>()
    .notNull()
    .default({ low: 480, normal: 240, high: 60, critical: 30 }),
  resolutionMinutes: jsonb("resolution_minutes")
    .$type<Record<string, number | null>>()
    .notNull()
    .default({ low: 4800, normal: 2400, high: 480, critical: 240 }),
  /** Statuses during which the resolution clock pauses (first response never pauses). */
  pauseStatuses: text("pause_statuses")
    .array()
    .notNull()
    .default(["awaiting_customer"]),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

/** Which policy applies to a company (customer agreement); the default policy covers the rest. */
export const helpdeskSlaAssignments = pgTable(
  "helpdesk_sla_assignments",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => helpdeskSlaPolicies.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.companyId] })],
);

export const ticketSlaEvents = pgTable(
  "ticket_sla_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    target: slaTargetKindEnum("target").notNull(),
    kind: slaEventKindEnum("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Business minutes consumed so far when this event was written. */
    elapsedMinutes: integer("elapsed_minutes"),
    policyId: uuid("policy_id"),
    reason: text("reason"),
  },
  (t) => [index("ticket_sla_events_ticket_idx").on(t.ticketId, t.target, t.at)],
);

export type RuleCondition = {
  field: string;
  op: "eq" | "neq" | "in" | "contains" | "empty" | "not_empty" | "gt" | "lt";
  value?: string | string[] | number | null;
};
export type RuleAction = {
  type:
    | "assign_user"
    | "assign_team"
    | "set_priority"
    | "set_status"
    | "set_category"
    | "add_tag"
    | "remove_tag"
    | "add_note"
    | "notify_users"
    | "notify_assignee"
    | "set_type"
    | "close";
  value?: string | string[] | null;
};

export const helpdeskAutomationRules = pgTable(
  "helpdesk_automation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    trigger: automationTriggerEnum("trigger").notNull(),
    /** all | any */
    match: text("match").notNull().default("all"),
    conditions: jsonb("conditions")
      .$type<RuleCondition[]>()
      .notNull()
      .default([]),
    actions: jsonb("actions").$type<RuleAction[]>().notNull().default([]),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Later rules for the same event are skipped once this one matches. */
    stopProcessing: boolean("stop_processing").notNull().default(false),
    /** A rule runs at most once per ticket within this many minutes (loop guard). */
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    /** For the schedule trigger: minutes a ticket must have sat in the matched state. */
    afterMinutes: integer("after_minutes"),
    active: boolean("active").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    index("helpdesk_rules_trigger_idx").on(t.trigger, t.active, t.sortOrder),
  ],
);

export const helpdeskAutomationRuns = pgTable(
  "helpdesk_automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => helpdeskAutomationRules.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    trigger: automationTriggerEnum("trigger").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    matched: boolean("matched").notNull(),
    actionsApplied: jsonb("actions_applied")
      .$type<RuleAction[]>()
      .notNull()
      .default([]),
    error: text("error"),
  },
  (t) => [
    index("helpdesk_runs_rule_idx").on(t.ruleId, t.ticketId, t.at),
    index("helpdesk_runs_ticket_idx").on(t.ticketId, t.at),
  ],
);

export const helpdeskTemplates = pgTable("helpdesk_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** public (customer reply) | internal (note) | both */
  scope: text("scope").notNull().default("public"),
  subject: text("subject"),
  body: text("body").notNull(),
  category: text("category"),
  active: boolean("active").notNull().default(true),
  createdByUserId: text("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  ...timestamps,
});

export const ticketChecklistItems = pgTable(
  "ticket_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    done: boolean("done").notNull().default(false),
    doneByUserId: text("done_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    assigneeUserId: text("assignee_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    dueDate: date("due_date"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [index("ticket_checklist_ticket_idx").on(t.ticketId, t.sortOrder)],
);

export const helpdeskNotifications = pgTable(
  "helpdesk_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, {
      onDelete: "cascade",
    }),
    messageId: uuid("message_id").references(() => ticketMessages.id, {
      onDelete: "set null",
    }),
    /** mention | assigned | customer_replied | sla_due | sla_breached | followed_update | automation | bounce */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("helpdesk_notifications_user_idx").on(
      t.userId,
      t.readAt,
      t.createdAt,
    ),
  ],
);
