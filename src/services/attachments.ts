import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import sharp from "sharp";
import { db } from "@/db";
import { companies, companyAttachments, sites, user } from "@/db/schema";
import { ActionError } from "@/lib/action-result";
import { audit, logActivity } from "@/lib/audit";
import { checkAttachmentPolicy, deleteAttachmentBytes, extensionOf, readAttachmentBytes, scanBytes, sha256, storeAttachmentBytes } from "@/lib/email/storage";
import { logger } from "@/lib/logger";

/**
 * Photos and documents on a company. Bytes live on the data volume (the
 * helpdesk's attachment root, scope `company`), metadata in
 * company_attachments. Uploads go through the same policy (blocked
 * extensions, size cap) and optional ClamAV scan as helpdesk attachments.
 *
 * Images are re-encoded with sharp on upload: EXIF orientation is applied,
 * every other tag (GPS, device, timestamps) is dropped, and a small WebP
 * thumbnail is stored beside the original so the grid never serves full
 * photos. Nothing here is reachable without the authorised route.
 */
export const ATTACHMENT_LIMITS = {
  /** Per company, all live attachments together. */
  companyQuotaBytes: Math.max(1, Number(process.env.ATTACHMENT_COMPANY_QUOTA_MB ?? 2048)) * 1024 * 1024,
  /** Soft-deleted attachments are purged (bytes too) after this many days. */
  purgeDays: Math.max(1, Number(process.env.ATTACHMENT_PURGE_DAYS ?? 30)),
  thumbnailPx: 480,
  /** Photos wider or taller than this are downsized on upload; originals from phones are 12+ MP and never needed at that size here. */
  maxImagePx: 4000,
} as const;

export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/tiff", "image/avif"]);

export type UploadFile = { name: string; type: string; bytes: Buffer };
export type UploadOptions = { caption?: string | null; siteId?: string | null; tags?: string[] };

const uploadedBy = alias(user, "uploaded_by");
const deletedBy = alias(user, "deleted_by");

function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200) || "file";
}

/** Re-encodes an image without metadata, downsized if huge, and makes a thumbnail. Returns null when sharp cannot read it (then it is stored as a plain file). */
async function processImage(bytes: Buffer): Promise<{ bytes: Buffer; contentType: string; width: number; height: number; thumb: Buffer; extension: string } | null> {
  try {
    const img = sharp(bytes, { failOn: "none", limitInputPixels: 80_000_000 }).rotate();
    const meta = await img.metadata();
    if (!meta.format || !meta.width || !meta.height) return null;
    const animated = (meta.pages ?? 1) > 1;
    // GIF animations and anything exotic are kept as-is (still no thumbnail from the first frame otherwise).
    const format = meta.format === "jpeg" ? "jpeg" : meta.format === "png" ? "png" : "webp";
    const resized = img.resize({ width: ATTACHMENT_LIMITS.maxImagePx, height: ATTACHMENT_LIMITS.maxImagePx, fit: "inside", withoutEnlargement: true });
    const out = animated
      ? bytes
      : format === "jpeg"
        ? await resized.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
        : format === "png"
          ? await resized.png({ compressionLevel: 8 }).toBuffer()
          : await resized.webp({ quality: 88 }).toBuffer();
    const final = await sharp(out).metadata();
    const thumb = await sharp(out, { failOn: "none" }).resize({ width: ATTACHMENT_LIMITS.thumbnailPx, height: ATTACHMENT_LIMITS.thumbnailPx, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    const contentType = animated ? `image/${meta.format}` : format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
    return { bytes: out, contentType, width: final.width ?? meta.width, height: final.height ?? meta.height, thumb, extension: animated ? extensionOf("x." + meta.format) : format === "jpeg" ? "jpg" : format };
  } catch (err) {
    logger.warn({ err }, "attachment image processing failed; storing as plain file");
    return null;
  }
}

export async function companyAttachmentUsage(companyId: string) {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(size_bytes), 0)`.mapWith(Number), count: sql<number>`count(*)`.mapWith(Number) })
    .from(companyAttachments)
    .where(and(eq(companyAttachments.companyId, companyId), isNull(companyAttachments.deletedAt)));
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0, quotaBytes: ATTACHMENT_LIMITS.companyQuotaBytes };
}

/** Stores one upload: policy, quota, scan, image processing, metadata row, audit and timeline. */
export async function uploadCompanyAttachment(actor: { id: string; name: string }, companyId: string, file: UploadFile, opts: UploadOptions = {}) {
  const name = cleanName(file.name);
  const policy = checkAttachmentPolicy(name, file.bytes.length);
  if (policy) throw new ActionError(`${name}: ${policy}`);
  if (file.bytes.length === 0) throw new ActionError(`${name}: the file is empty`);
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new ActionError("Company not found.");
  if (opts.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, opts.siteId), eq(sites.companyId, companyId))).limit(1);
    if (!site) throw new ActionError("That site does not belong to this company.");
  }
  const usage = await companyAttachmentUsage(companyId);
  if (usage.bytes + file.bytes.length > ATTACHMENT_LIMITS.companyQuotaBytes) throw new ActionError(`${name}: this company's attachment allowance (${Math.round(ATTACHMENT_LIMITS.companyQuotaBytes / 1024 / 1024)} MB) would be exceeded.`);

  const scan = await scanBytes(file.bytes);
  if (scan.status === "blocked") {
    await audit({ actorUserId: actor.id, action: "attachment.blocked", entityType: "company", entityId: companyId, details: { fileName: name, detail: scan.detail } });
    throw new ActionError(`${name} was blocked by the virus scanner (${scan.detail}).`);
  }

  const declaredImage = IMAGE_TYPES.has((file.type || "").toLowerCase()) || /^(jpe?g|png|webp|gif|heic|heif|tiff?|avif)$/.test(extensionOf(name));
  const image = declaredImage ? await processImage(file.bytes) : null;
  const bytes = image ? image.bytes : file.bytes;
  const contentType = image ? image.contentType : file.type?.trim().toLowerCase().slice(0, 120) || "application/octet-stream";
  const id = randomUUID();
  const scope = `company/${companyId}`;
  const storagePath = await storeAttachmentBytes(scope, id, bytes);
  const thumbnailPath = image ? await storeAttachmentBytes(`${scope}/thumbs`, `${id}.webp`, image.thumb) : null;
  // When the image was re-encoded, keep the file name's extension honest.
  const fileName = image && extensionOf(name) !== image.extension && !/^image\/gif/.test(image.contentType) ? name.replace(/\.[a-z0-9]{1,8}$/i, "") + "." + image.extension : name;

  await db.transaction(async (tx) => {
    await tx.insert(companyAttachments).values({
      id,
      companyId,
      siteId: opts.siteId ?? null,
      fileName,
      contentType,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      storagePath,
      thumbnailPath,
      width: image?.width ?? null,
      height: image?.height ?? null,
      caption: opts.caption?.trim().slice(0, 500) || null,
      tags: (opts.tags ?? []).map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20),
      scanStatus: scan.status,
      scanDetail: scan.detail,
      uploadedByUserId: actor.id,
    });
    await audit({ actorUserId: actor.id, action: "attachment.upload", entityType: "company_attachment", entityId: id, details: { companyId, fileName, contentType, sizeBytes: bytes.length, image: Boolean(image) } }, tx);
    await logActivity({ type: "system", companyId, entityType: "company_attachment", entityId: id, title: `${image ? "Photo" : "File"} added: ${fileName}`, body: opts.caption?.trim() || null, actorUserId: actor.id }, tx);
  });
  return { id, fileName, contentType, sizeBytes: bytes.length, isImage: Boolean(image) };
}

export type AttachmentRow = {
  id: string;
  companyId: string;
  siteId: string | null;
  siteName: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  caption: string | null;
  tags: string[];
  isImage: boolean;
  hasThumbnail: boolean;
  scanStatus: string;
  uploadedByName: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  deletedByName: string | null;
};

const toRow = (r: { a: typeof companyAttachments.$inferSelect; siteName: string | null; uploadedByName: string | null; deletedByName: string | null }): AttachmentRow => ({
  id: r.a.id,
  companyId: r.a.companyId,
  siteId: r.a.siteId,
  siteName: r.siteName,
  fileName: r.a.fileName,
  contentType: r.a.contentType,
  sizeBytes: r.a.sizeBytes,
  width: r.a.width,
  height: r.a.height,
  caption: r.a.caption,
  tags: r.a.tags,
  isImage: r.a.contentType.startsWith("image/"),
  hasThumbnail: Boolean(r.a.thumbnailPath),
  scanStatus: r.a.scanStatus,
  uploadedByName: r.uploadedByName,
  createdAt: r.a.createdAt,
  deletedAt: r.a.deletedAt,
  deletedByName: r.deletedByName,
});

/** Newest first. Deleted ones only on request. */
export async function listCompanyAttachments(companyId: string, opts: { includeDeleted?: boolean; siteId?: string | null } = {}): Promise<AttachmentRow[]> {
  const rows = await db
    .select({ a: companyAttachments, siteName: sites.name, uploadedByName: uploadedBy.name, deletedByName: deletedBy.name })
    .from(companyAttachments)
    .leftJoin(sites, eq(sites.id, companyAttachments.siteId))
    .leftJoin(uploadedBy, eq(uploadedBy.id, companyAttachments.uploadedByUserId))
    .leftJoin(deletedBy, eq(deletedBy.id, companyAttachments.deletedByUserId))
    .where(and(eq(companyAttachments.companyId, companyId), opts.includeDeleted ? undefined : isNull(companyAttachments.deletedAt), opts.siteId ? eq(companyAttachments.siteId, opts.siteId) : undefined))
    .orderBy(desc(companyAttachments.createdAt), asc(companyAttachments.fileName));
  return rows.map(toRow);
}

export async function getAttachment(id: string) {
  const [row] = await db.select().from(companyAttachments).where(eq(companyAttachments.id, id)).limit(1);
  return row ?? null;
}

/** Bytes for the download route: the original or the thumbnail. */
export async function readAttachment(id: string, variant: "original" | "thumb" = "original") {
  const row = await getAttachment(id);
  if (!row) return null;
  const rel = variant === "thumb" ? row.thumbnailPath : row.storagePath;
  if (!rel) return null;
  const bytes = await readAttachmentBytes(rel);
  return { row, bytes, contentType: variant === "thumb" ? "image/webp" : row.contentType };
}

export async function updateAttachment(actor: { id: string }, id: string, patch: { caption?: string | null; siteId?: string | null; tags?: string[]; fileName?: string }) {
  const row = await getAttachment(id);
  if (!row) throw new ActionError("Attachment not found.");
  if (patch.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, patch.siteId), eq(sites.companyId, row.companyId))).limit(1);
    if (!site) throw new ActionError("That site does not belong to this company.");
  }
  const set: Partial<typeof companyAttachments.$inferInsert> = { updatedAt: new Date() };
  if (patch.caption !== undefined) set.caption = patch.caption?.trim().slice(0, 500) || null;
  if (patch.siteId !== undefined) set.siteId = patch.siteId || null;
  if (patch.tags !== undefined) set.tags = patch.tags.map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  if (patch.fileName !== undefined) {
    const next = cleanName(patch.fileName);
    if (!next) throw new ActionError("Give the file a name.");
    const oldExt = extensionOf(row.fileName);
    set.fileName = oldExt && extensionOf(next) !== oldExt ? `${next}.${oldExt}` : next;
  }
  await db.transaction(async (tx) => {
    await tx.update(companyAttachments).set(set).where(eq(companyAttachments.id, id));
    await audit({ actorUserId: actor.id, action: "attachment.update", entityType: "company_attachment", entityId: id, details: { companyId: row.companyId, ...patch } }, tx);
  });
  return row.companyId;
}

/** Soft delete (restore with `restore`). Bytes stay until the nightly purge so a mistake is recoverable. */
export async function deleteAttachment(actor: { id: string }, id: string, restore = false) {
  const row = await getAttachment(id);
  if (!row) throw new ActionError("Attachment not found.");
  await db.transaction(async (tx) => {
    await tx.update(companyAttachments).set({ deletedAt: restore ? null : new Date(), deletedByUserId: restore ? null : actor.id, updatedAt: new Date() }).where(eq(companyAttachments.id, id));
    await audit({ actorUserId: actor.id, action: restore ? "attachment.restore" : "attachment.delete", entityType: "company_attachment", entityId: id, details: { companyId: row.companyId, fileName: row.fileName } }, tx);
    await logActivity({ type: "system", companyId: row.companyId, entityType: "company_attachment", entityId: id, title: `${restore ? "File restored" : "File removed"}: ${row.fileName}`, actorUserId: actor.id }, tx);
  });
  return row.companyId;
}

/** Nightly: removes the bytes and rows of attachments deleted more than purgeDays ago. */
export async function purgeDeletedAttachments(now = new Date()) {
  const before = new Date(now.getTime() - ATTACHMENT_LIMITS.purgeDays * 86400000);
  const rows = await db.select().from(companyAttachments).where(and(isNotNull(companyAttachments.deletedAt), lt(companyAttachments.deletedAt, before)));
  let purged = 0;
  for (const r of rows) {
    await deleteAttachmentBytes(r.storagePath);
    if (r.thumbnailPath) await deleteAttachmentBytes(r.thumbnailPath);
    await db.delete(companyAttachments).where(eq(companyAttachments.id, r.id));
    purged++;
  }
  if (purged) logger.info({ purged }, "purged deleted company attachments");
  return purged;
}

export async function attachmentCounts(companyIds: string[]) {
  if (!companyIds.length) return new Map<string, number>();
  const rows = await db
    .select({ companyId: companyAttachments.companyId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(companyAttachments)
    .where(and(isNull(companyAttachments.deletedAt), sql`${companyAttachments.companyId} = any(${companyIds})`))
    .groupBy(companyAttachments.companyId);
  return new Map(rows.map((r) => [r.companyId, r.n]));
}
