import { bigint, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { companies, sites, timestamps } from "./core";
import { attachmentScanStatusEnum } from "./helpdesk";

/**
 * Photos and documents attached to a company (optionally pinned to a site):
 * comms cabinet photos, floor plans, contracts, network diagrams. Metadata
 * lives here; the bytes live on the data volume under the attachment root
 * (see src/lib/email/storage.ts) and are only ever served through the
 * authorised download route. Images are re-encoded on upload so EXIF (GPS,
 * device) is stripped, and a small thumbnail is kept beside the original.
 */
export const companyAttachments = pgTable(
  "company_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    sha256: text("sha256").notNull(),
    /** Relative path under the attachment root. */
    storagePath: text("storage_path").notNull(),
    /** Relative path of the WebP thumbnail, images only. */
    thumbnailPath: text("thumbnail_path"),
    width: integer("width"),
    height: integer("height"),
    caption: text("caption"),
    tags: text("tags").array().notNull().default([]),
    scanStatus: attachmentScanStatusEnum("scan_status").notNull().default("pending"),
    scanDetail: text("scan_detail"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
    /** Soft delete: hidden from the company page, purged with its bytes after ATTACHMENT_PURGE_DAYS. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: text("deleted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("company_attachments_company_idx").on(t.companyId, t.deletedAt), index("company_attachments_site_idx").on(t.siteId), index("company_attachments_deleted_idx").on(t.deletedAt)],
);
