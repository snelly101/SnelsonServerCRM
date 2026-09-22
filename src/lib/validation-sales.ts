import { z } from "zod";

const trimmed = z.string().trim();
const optionalText = trimmed.max(500).optional().or(z.literal("")).transform((v) => (v ? v : null));
const optionalLong = trimmed.max(10_000).optional().or(z.literal("")).transform((v) => (v ? v : null));
const uuid = z.uuid();
const optionalUuid = z.union([uuid, z.literal("")]).optional().transform((v) => (v ? v : null));
const optionalDate = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"), z.literal("")])
  .optional()
  .transform((v) => (v ? v : null));
const money = z.coerce.number().min(0).max(1_000_000_000);
const optionalMoney = z
  .union([z.coerce.number().min(0).max(1_000_000_000), z.literal(""), z.null(), z.undefined()])
  .transform((v) => (v === "" || v === null || v === undefined ? null : v));
/** Accepts true/false, "true"/"false", "on"; anything else is false. `z.coerce.boolean()` would treat "false" as true. */
export const boolish = z
  .union([z.boolean(), z.string(), z.null()])
  .optional()
  .transform((v) => v === true || v === "true" || v === "on");
const optionalUserId = z.string().trim().optional().or(z.literal("")).transform((v) => (v ? v : null));

export const productCategoryValues = ["managed_it", "microsoft_365", "security", "backup", "networking", "hardware", "consultancy", "other"] as const;
export const pricingModelValues = ["per_user", "per_device", "fixed", "one_off"] as const;
export const revenueTypeValues = ["recurring", "one_off_project", "hardware"] as const;
export const billingFrequencyValues = ["monthly", "quarterly", "annual", "one_off"] as const;

export const CATEGORY_LABELS: Record<(typeof productCategoryValues)[number], string> = {
  managed_it: "Managed IT",
  microsoft_365: "Microsoft 365",
  security: "Security",
  backup: "Backup",
  networking: "Networking",
  hardware: "Hardware",
  consultancy: "Consultancy",
  other: "Other",
};
export const PRICING_LABELS: Record<(typeof pricingModelValues)[number], string> = {
  per_user: "Per user",
  per_device: "Per device",
  fixed: "Fixed fee",
  one_off: "One-off",
};
export const REVENUE_LABELS: Record<(typeof revenueTypeValues)[number], string> = {
  recurring: "Recurring",
  one_off_project: "Project (one-off)",
  hardware: "Hardware",
};
export const FREQUENCY_LABELS: Record<(typeof billingFrequencyValues)[number], string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  one_off: "One-off",
};

export const productSchema = z.object({
  sku: optionalText,
  name: trimmed.min(1, "Name is required").max(200),
  category: z.enum(productCategoryValues).default("managed_it"),
  description: optionalLong,
  pricingModel: z.enum(pricingModelValues).default("per_user"),
  revenueType: z.enum(revenueTypeValues).default("recurring"),
  billingFrequency: z.enum(billingFrequencyValues).default("monthly"),
  unitPrice: money.default(0),
  unitCost: optionalMoney,
  countsAsManagedDevice: boolish,
  active: boolish.default(true),
});
export type ProductInput = z.infer<typeof productSchema>;

export const lineSchema = z.object({
  id: optionalUuid,
  productId: optionalUuid,
  description: trimmed.min(1, "Description is required").max(300),
  revenueType: z.enum(revenueTypeValues).default("recurring"),
  pricingModel: z.enum(pricingModelValues).default("per_user"),
  billingFrequency: z.enum(billingFrequencyValues).default("monthly"),
  quantity: z.coerce.number().min(0).max(1_000_000).default(1),
  unitPrice: money.default(0),
  unitCost: optionalMoney,
});
export type LineInput = z.infer<typeof lineSchema>;

export const opportunitySchema = z.object({
  companyId: uuid,
  contactId: optionalUuid,
  title: trimmed.min(1, "Title is required").max(200),
  stageId: uuid,
  ownerUserId: optionalUserId,
  expectedCloseDate: optionalDate,
  probability: z.coerce.number().int().min(0).max(100).optional(),
  leadSource: optionalText,
  nextAction: optionalText,
  nextActionDate: optionalDate,
  notes: optionalLong,
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export type OpportunityInput = z.infer<typeof opportunitySchema>;

export const stageSchema = z.object({
  name: trimmed.min(1).max(60),
  probability: z.coerce.number().int().min(0).max(100).default(10),
  color: z.enum(["slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"]).default("slate"),
});

export const contractSchema = z.object({
  companyId: uuid,
  opportunityId: optionalUuid,
  name: trimmed.min(1, "Name is required").max(200),
  reference: optionalText,
  status: z.enum(["draft", "active", "expired", "cancelled"]).default("draft"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Start date is required"),
  endDate: optionalDate,
  renewalDate: optionalDate,
  noticePeriodDays: z.coerce.number().int().min(0).max(730).default(90),
  autoRenew: boolish.default(true),
  billingFrequency: z.enum(billingFrequencyValues).default("monthly"),
  nextReviewDate: optionalDate,
  reviewIntervalMonths: z.coerce.number().int().min(1).max(36).default(6),
  ownerUserId: optionalUserId,
  notes: optionalLong,
});
export type ContractInput = z.infer<typeof contractSchema>;

export const contractLineSchema = lineSchema.extend({
  siteId: optionalUuid,
  countsAsManagedDevice: boolish,
});
export type ContractLineInput = z.infer<typeof contractLineSchema>;

export const taskSchema = z.object({
  title: trimmed.min(1, "Title is required").max(200),
  description: optionalLong,
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueDate: optionalDate,
  ownerUserId: optionalUserId,
  companyId: optionalUuid,
  opportunityId: optionalUuid,
  contractId: optionalUuid,
  onboardingId: optionalUuid,
});
export type TaskInput = z.infer<typeof taskSchema>;

export const checklistTemplateSchema = z.object({
  name: trimmed.min(1).max(120),
  description: optionalText,
  isDefaultOnboarding: boolish,
  items: z
    .array(
      z.object({
        title: trimmed.min(1).max(200),
        dueOffsetDays: z.coerce.number().int().min(0).max(365).default(7),
        defaultOwnerRole: optionalText,
      }),
    )
    .min(1, "Add at least one item"),
});

/** Parses repeated line-item form fields (lines[0][description] etc.) into an array. */
export function linesFromForm(obj: Record<string, unknown>, key = "lines"): Record<string, unknown>[] {
  const rows = new Map<number, Record<string, unknown>>();
  const re = new RegExp(`^${key}\\[(\\d+)\\]\\[(\\w+)\\]$`);
  for (const [k, v] of Object.entries(obj)) {
    const m = re.exec(k);
    if (!m) continue;
    const idx = Number(m[1]);
    const row = rows.get(idx) ?? {};
    row[m[2]] = v;
    rows.set(idx, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}
