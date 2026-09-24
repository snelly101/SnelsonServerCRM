import { z } from "zod";

export const TICKET_STATUSES = [
  "new",
  "open",
  "in_progress",
  "awaiting_customer",
  "awaiting_third_party",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  in_progress: "In progress",
  awaiting_customer: "Awaiting customer",
  awaiting_third_party: "Awaiting third party",
  resolved: "Resolved",
  closed: "Closed",
  cancelled: "Cancelled",
};
export const TICKET_STATUS_TONES: Record<TicketStatus, string> = {
  new: "blue",
  open: "amber",
  in_progress: "purple",
  awaiting_customer: "slate",
  awaiting_third_party: "slate",
  resolved: "green",
  closed: "slate",
  cancelled: "red",
};
/** Statuses that count as "open work". */
export const OPEN_STATUSES: TicketStatus[] = [
  "new",
  "open",
  "in_progress",
  "awaiting_customer",
  "awaiting_third_party",
];

export const TICKET_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
};
export const TICKET_PRIORITY_TONES: Record<TicketPriority, string> = {
  low: "slate",
  normal: "blue",
  high: "amber",
  critical: "red",
};

export const TICKET_TYPES = [
  "incident",
  "service_request",
  "problem",
  "change",
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  incident: "Incident",
  service_request: "Service request",
  problem: "Problem",
  change: "Change",
};

export const RESOLUTION_CATEGORIES = [
  "fixed",
  "workaround",
  "user_education",
  "no_fault_found",
  "duplicate",
  "cannot_reproduce",
  "third_party",
  "withdrawn",
] as const;
export const RESOLUTION_CATEGORY_LABELS: Record<
  (typeof RESOLUTION_CATEGORIES)[number],
  string
> = {
  fixed: "Fixed",
  workaround: "Workaround",
  user_education: "User education",
  no_fault_found: "No fault found",
  duplicate: "Duplicate",
  cannot_reproduce: "Cannot reproduce",
  third_party: "Third party",
  withdrawn: "Withdrawn",
};

const trimmed = z.string().trim();
const uuid = z.uuid();
const optionalUuid = z
  .union([uuid, z.literal("")])
  .optional()
  .transform((v) => (v ? v : null));
const optionalUserId = trimmed
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));
const optionalText = trimmed
  .max(500)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));
const optionalLong = trimmed
  .max(50_000)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null));
const optionalEmail = trimmed
  .toLowerCase()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null))
  .refine(
    (v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    "Enter a valid e-mail address",
  );
/** Comma or newline separated tags → unique lower-case list. */
const tagList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    const raw = Array.isArray(v) ? v : (v ?? "").split(/[,\n]/);
    return [
      ...new Set(raw.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    ].slice(0, 20);
  });
const version = z.coerce.number().int().min(1).optional();

export const ticketCreateSchema = z
  .object({
    subject: trimmed.min(1, "Subject is required").max(300),
    description: optionalLong,
    priority: z.enum(TICKET_PRIORITIES).default("normal"),
    type: z.enum(TICKET_TYPES).default("incident"),
    categoryId: optionalUuid,
    subcategoryId: optionalUuid,
    tags: tagList,
    requesterContactId: optionalUuid,
    requesterName: optionalText,
    requesterEmail: optionalEmail,
    companyId: optionalUuid,
    assigneeUserId: optionalUserId,
    teamId: optionalUuid,
    customFields: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .refine((v) => v.requesterContactId || v.requesterEmail || v.requesterName, {
    message: "Choose a contact or enter the requester's name or e-mail",
    path: ["requesterContactId"],
  });
export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;

export const ticketFieldsSchema = z.object({
  subject: trimmed.min(1).max(300),
  priority: z.enum(TICKET_PRIORITIES),
  type: z.enum(TICKET_TYPES),
  categoryId: optionalUuid,
  subcategoryId: optionalUuid,
  tags: tagList,
  requesterContactId: optionalUuid,
  requesterName: optionalText,
  requesterEmail: optionalEmail,
  companyId: optionalUuid,
  assigneeUserId: optionalUserId,
  teamId: optionalUuid,
  customFields: z.record(z.string(), z.unknown()).optional().default({}),
  version,
});
export type TicketFieldsInput = z.infer<typeof ticketFieldsSchema>;

export const ticketStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  resolutionSummary: optionalLong,
  resolutionCategory: z
    .enum(RESOLUTION_CATEGORIES)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  version,
});

export const ticketMessageSchema = z.object({
  kind: z.enum(["public", "internal"]).default("internal"),
  body: trimmed.min(1, "Write something first").max(50_000),
  /** For public messages logged by hand (phone call, walk-up) rather than e-mailed. */
  channel: z.enum(["manual", "note", "email"]).default("note"),
  to: z.array(z.string().trim().toLowerCase()).optional().default([]),
  cc: z.array(z.string().trim().toLowerCase()).optional().default([]),
  bcc: z.array(z.string().trim().toLowerCase()).optional().default([]),
  /** Optional status to apply in the same action. */
  status: z
    .enum(TICKET_STATUSES)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  replyToMessageId: optionalUuid,
  version,
});
export type TicketMessageInput = z.infer<typeof ticketMessageSchema>;

export const timeEntrySchema = z.object({
  minutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  note: optionalText,
  billable: z.boolean().default(true),
  date: trimmed
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
});

export const teamSchema = z.object({
  name: trimmed.min(1).max(80),
  description: optionalText,
  memberIds: z.array(z.string()).optional().default([]),
  leadUserId: optionalUserId,
  active: z.boolean().default(true),
});
export const categorySchema = z.object({
  name: trimmed.min(1).max(80),
  parentId: optionalUuid,
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});

export const bulkActionSchema = z.object({
  ids: z.array(uuid).min(1).max(200),
  action: z.enum(["assign", "team", "priority", "status"]),
  value: z.string().max(100),
});

export const ticketLinkSchema = z.object({
  reference: trimmed.min(1),
  kind: z.enum(["related", "parent", "duplicate"]).default("related"),
});
export const splitSchema = z.object({
  messageIds: z.array(uuid).min(1),
  subject: trimmed.min(1).max(300),
});
export const participantSchema = z.object({
  email: trimmed
    .toLowerCase()
    .refine(
      (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      "Enter a valid e-mail address",
    ),
  name: optionalText,
  role: z.enum(["cc", "requester"]).default("cc"),
});

export const TICKET_VIEWS = [
  "my",
  "unassigned",
  "open",
  "awaiting_customer",
  "awaiting_third_party",
  "overdue",
  "recent",
  "resolved",
  "review",
  "all",
] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];
export const TICKET_VIEW_LABELS: Record<TicketView, string> = {
  my: "My tickets",
  unassigned: "Unassigned",
  open: "All open",
  awaiting_customer: "Awaiting customer",
  awaiting_third_party: "Awaiting third party",
  overdue: "Overdue",
  recent: "Recently updated",
  resolved: "Resolved",
  review: "Needs review",
  all: "All",
};

export const TICKET_COLUMNS = [
  "reference",
  "subject",
  "status",
  "priority",
  "type",
  "requester",
  "company",
  "assignee",
  "team",
  "category",
  "updated",
  "created",
  "due",
  "time",
] as const;
export type TicketColumn = (typeof TICKET_COLUMNS)[number];
export const TICKET_COLUMN_LABELS: Record<TicketColumn, string> = {
  reference: "Ref",
  subject: "Subject",
  status: "Status",
  priority: "Priority",
  type: "Type",
  requester: "Requester",
  company: "Company",
  assignee: "Assignee",
  team: "Team",
  category: "Category",
  updated: "Updated",
  created: "Created",
  due: "Due",
  time: "Time",
};
export const DEFAULT_TICKET_COLUMNS: TicketColumn[] = [
  "reference",
  "subject",
  "status",
  "priority",
  "requester",
  "company",
  "assignee",
  "updated",
];

export function ticketReference(number: number) {
  return `IT-${String(number).padStart(6, "0")}`;
}
/** Finds ticket references like IT-000123 in free text (subject lines). Case-insensitive; returns numbers in order of appearance. */
export function findTicketReferences(
  text: string | null | undefined,
): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const m of text.matchAll(/\bIT-(\d{3,9})\b/gi)) {
    const n = Number(m[1]);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}
