import { z } from "zod";
import { ROLES } from "./permissions";

const trimmed = z.string().trim();
const optionalText = trimmed.max(500).optional().or(z.literal("")).transform((v) => (v ? v : null));
const optionalLong = trimmed.max(10_000).optional().or(z.literal("")).transform((v) => (v ? v : null));
const optionalEmail = trimmed
  .max(320)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || z.email().safeParse(v).success, "Enter a valid email address");
const optionalUrl = trimmed
  .max(500)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v), "Enter a valid website");
export const boolish = z
  .union([z.boolean(), z.string(), z.null()])
  .optional()
  .transform((v) => v === true || v === "true" || v === "on");
const uuid = z.uuid();
const optionalUuid = z.union([uuid, z.literal("")]).optional().transform((v) => (v ? v : null));

export const companyStatusValues = ["prospect", "customer", "former", "other"] as const;
export const contactRoleValues = ["decision_maker", "technical", "billing", "primary", "other"] as const;

export const addressSchema = {
  addressLine1: optionalText,
  addressLine2: optionalText,
  city: optionalText,
  region: optionalText,
  postcode: optionalText,
  country: trimmed.max(2).optional().or(z.literal("")).transform((v) => (v ? v.toUpperCase() : "GB")),
};

export const companySchema = z.object({
  name: trimmed.min(1, "Company name is required").max(200),
  status: z.enum(companyStatusValues).default("prospect"),
  website: optionalUrl,
  industry: optionalText,
  phone: optionalText,
  email: optionalEmail,
  companyNumber: optionalText,
  vatNumber: optionalText,
  ownerUserId: z.string().trim().optional().or(z.literal("")).transform((v) => (v ? v : null)),
  ...addressSchema,
  notes: optionalLong,
  tagIds: z.array(uuid).default([]),
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export type CompanyInput = z.infer<typeof companySchema>;

export const siteSchema = z.object({
  companyId: uuid,
  name: trimmed.min(1, "Site name is required").max(200),
  isPrimary: boolish,
  phone: optionalText,
  ...addressSchema,
  notes: optionalLong,
});
export type SiteInput = z.infer<typeof siteSchema>;

export const contactSchema = z.object({
  companyId: uuid,
  siteId: optionalUuid,
  firstName: trimmed.min(1, "First name is required").max(100),
  lastName: trimmed.max(100).optional().or(z.literal("")).transform((v) => v ?? ""),
  email: optionalEmail,
  phone: optionalText,
  mobile: optionalText,
  jobTitle: optionalText,
  roles: z.array(z.enum(contactRoleValues)).default([]),
  isPrimary: boolish,
  notes: optionalLong,
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const tagSchema = z.object({
  name: trimmed.min(1).max(50),
  color: z.enum(["slate", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink"]).default("slate"),
});

export const customFieldDefSchema = z.object({
  entity: z.enum(["company", "contact", "opportunity"]),
  key: trimmed
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, "Use lower-case letters, numbers and underscores; start with a letter"),
  label: trimmed.min(1).max(100),
  type: z.enum(["text", "number", "date", "boolean", "select"]).default("text"),
  options: z.array(trimmed.min(1).max(100)).default([]),
  required: boolish,
});

export const noteSchema = z.object({
  companyId: uuid,
  contactId: optionalUuid,
  type: z.enum(["note", "call", "email", "meeting"]).default("note"),
  title: trimmed.min(1, "A title is required").max(200),
  body: optionalLong,
});

export const userCreateSchema = z.object({
  name: trimmed.min(1, "Name is required").max(100),
  email: trimmed.min(1, "Email is required").max(320).toLowerCase().pipe(z.email("Enter a valid email address")),
  role: z.enum(ROLES),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export const userUpdateSchema = z.object({
  id: z.string().min(1),
  name: trimmed.min(1).max(100),
  role: z.enum(ROLES),
  active: boolish,
  password: z.union([z.string().min(10, "Password must be at least 10 characters").max(200), z.literal("")]).optional(),
});

export const appSettingsSchema = z.object({
  companyName: trimmed.min(1).max(100),
  currency: trimmed.length(3, "Use a 3-letter ISO code such as GBP").toUpperCase(),
  dateFormat: z.enum(["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "d MMM yyyy"]),
  timezone: trimmed.min(1).max(64),
  defaultTaxRatePercent: z.coerce.number().min(0).max(100),
  taxLabel: trimmed.min(1).max(20),
  deviceActiveDays: z.coerce.number().int().min(1).max(365),
  // Vault settings are edited on their own page; absent keys leave the stored values untouched.
  vaultRevealSeconds: z.coerce.number().int().min(5).max(600).optional(),
  vaultClipboardSeconds: z.coerce.number().int().min(0).max(600).optional(),
  vaultStepUpMinutes: z.coerce.number().int().min(1).max(720).optional(),
  vaultReviewReminderDays: z.coerce.number().int().min(1).max(180).optional(),
  vaultRevealLimit: z.coerce.number().int().min(1).max(10000).optional(),
});
export const securitySettingsSchema = z.object({
  twoFactorRequiredRoles: z.array(z.enum(["admin", "sales", "account_manager", "finance", "technician", "read_only"])).default([]),
  twoFactorDeadline: z.preprocess((v) => (v === "" || v === null || v === undefined ? null : v), z.union([z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date")])),
});
export type SecuritySettingsInput = z.infer<typeof securitySettingsSchema>;

export const vaultSettingsSchema = appSettingsSchema.pick({ vaultRevealSeconds: true, vaultClipboardSeconds: true, vaultStepUpMinutes: true, vaultReviewReminderDays: true, vaultRevealLimit: true }).required();

export const savedViewSchema = z.object({
  page: trimmed.min(1).max(50),
  name: trimmed.min(1).max(60),
  params: z.record(z.string(), z.string()),
  isShared: boolish,
});

/** Turns FormData into a plain object; repeated keys become arrays. Keys ending in [] are always arrays. */
export function formToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of fd.entries()) {
    if (rawKey.startsWith("$ACTION")) continue;
    const isArray = rawKey.endsWith("[]");
    const key = isArray ? rawKey.slice(0, -2) : rawKey;
    const v = typeof value === "string" ? value : value.name;
    if (isArray) {
      if (Array.isArray(out[key])) (out[key] as unknown[]).push(v);
      else out[key] = [v];
    } else if (key in out) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else {
      out[key] = v;
    }
  }
  for (const [k, v] of Object.entries(out)) {
    // Checkboxes send "on"; coerce to boolean-ish strings zod can read.
    if (v === "on") out[k] = "true";
  }
  return out;
}
