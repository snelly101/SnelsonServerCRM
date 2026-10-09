import { describe, expect, it, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activities, auditLog, companyAttachments, sites } from "@/db/schema";
import { createCompany } from "@/services/companies";
import { companySchema } from "@/lib/validation";
import { ATTACHMENT_ROOT } from "@/lib/email/storage";
import { ATTACHMENT_LIMITS, companyAttachmentUsage, deleteAttachment, getAttachment, listCompanyAttachments, purgeDeletedAttachments, readAttachment, updateAttachment, uploadCompanyAttachment } from "@/services/attachments";
import { makeUser } from "./helpers";

let admin: { id: string; name: string };
let companyId: string;
let otherCompanyId: string;
let siteId: string;

/** A 1600×1200 JPEG with EXIF (including a GPS block) and a rotation tag, like a phone photo. */
async function phonePhoto() {
  return sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "TestPhone", Model: "T1", Software: "vitest" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "53/1 48/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "1/1 33/1 0/1" } } })
    .toBuffer();
}

beforeAll(async () => {
  admin = await makeUser("admin", "Files Admin");
  companyId = await createCompany(companySchema.parse({ name: "Files Test Ltd", status: "customer" }), admin.id);
  otherCompanyId = await createCompany(companySchema.parse({ name: "Other Files Ltd", status: "customer" }), admin.id);
  const [s] = await db.insert(sites).values({ companyId, name: "Head office" }).returning({ id: sites.id });
  siteId = s.id;
});

describe("company attachments", () => {
  let photoId: string;
  let docId: string;

  it("stores a photo re-encoded without EXIF, rotated, with a thumbnail, and records it", async () => {
    const bytes = await phonePhoto();
    expect((await sharp(bytes).metadata()).exif).toBeTruthy();
    const r = await uploadCompanyAttachment(admin, companyId, { name: "IMG_0001.JPG", type: "image/jpeg", bytes }, { caption: "Comms cabinet", siteId });
    photoId = r.id;
    expect(r.isImage).toBe(true);
    expect(r.fileName).toBe("IMG_0001.JPG"); // an extension that already matches is left as typed
    const row = (await getAttachment(photoId))!;
    expect(row.contentType).toBe("image/jpeg");
    expect(row.thumbnailPath).toBeTruthy();
    expect(row.siteId).toBe(siteId);
    expect(row.caption).toBe("Comms cabinet");
    // Orientation 6 means the stored image is rotated to portrait, and no EXIF survives.
    expect(row.width).toBe(1200);
    expect(row.height).toBe(1600);
    const stored = (await readAttachment(photoId, "original"))!;
    const meta = await sharp(stored.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(stored.bytes.includes(Buffer.from("TestPhone"))).toBe(false);
    const thumb = (await readAttachment(photoId, "thumb"))!;
    expect(thumb.contentType).toBe("image/webp");
    const tmeta = await sharp(thumb.bytes).metadata();
    expect(tmeta.format).toBe("webp");
    expect(Math.max(tmeta.width ?? 0, tmeta.height ?? 0)).toBeLessThanOrEqual(ATTACHMENT_LIMITS.thumbnailPx);
    expect(existsSync(path.join(ATTACHMENT_ROOT, row.storagePath))).toBe(true);
    const [a] = await db.select().from(auditLog).where(eq(auditLog.entityId, photoId));
    expect(a.action).toBe("attachment.upload");
    const acts = await db.select().from(activities).where(eq(activities.entityId, photoId));
    expect(acts[0].title).toBe("Photo added: IMG_0001.JPG");
  });

  it("stores a document as-is, refuses blocked extensions, empty files and foreign sites", async () => {
    const pdf = Buffer.from("%PDF-1.4\n% test document\n");
    const r = await uploadCompanyAttachment(admin, companyId, { name: "floor plan.pdf", type: "application/pdf", bytes: pdf });
    docId = r.id;
    expect(r.isImage).toBe(false);
    const row = (await getAttachment(docId))!;
    expect(row.thumbnailPath).toBeNull();
    expect((await readAttachment(docId))!.bytes.equals(pdf)).toBe(true);
    await expect(uploadCompanyAttachment(admin, companyId, { name: "setup.exe", type: "application/octet-stream", bytes: Buffer.from("MZ") })).rejects.toThrow(/not accepted/);
    await expect(uploadCompanyAttachment(admin, companyId, { name: "empty.txt", type: "text/plain", bytes: Buffer.alloc(0) })).rejects.toThrow(/empty/);
    await expect(uploadCompanyAttachment(admin, otherCompanyId, { name: "x.txt", type: "text/plain", bytes: Buffer.from("hi") }, { siteId })).rejects.toThrow(/does not belong/);
    // A file claiming to be an image but not decodable is kept as a plain file.
    const fake = await uploadCompanyAttachment(admin, companyId, { name: "notreally.png", type: "image/png", bytes: Buffer.from("this is not a png") });
    expect(fake.isImage).toBe(false);
  });

  it("lists newest first with site and uploader, counts usage, and enforces the company allowance", async () => {
    const list = await listCompanyAttachments(companyId);
    expect(list.map((a) => a.fileName)).toEqual(["notreally.png", "floor plan.pdf", "IMG_0001.JPG"]);
    const photo = list.find((a) => a.id === photoId)!;
    expect(photo).toMatchObject({ isImage: true, hasThumbnail: true, siteName: "Head office", uploadedByName: "Files Admin", scanStatus: "skipped" });
    expect((await listCompanyAttachments(companyId, { siteId })).map((a) => a.id)).toEqual([photoId]);
    const usage = await companyAttachmentUsage(companyId);
    expect(usage.count).toBe(3);
    expect(usage.bytes).toBeGreaterThan(0);
    // Fill the allowance with a metadata-only row, then any upload must be refused.
    const [filler] = await db.insert(companyAttachments).values({ companyId, fileName: "filler.bin", contentType: "application/octet-stream", sizeBytes: ATTACHMENT_LIMITS.companyQuotaBytes - 10, sha256: "x", storagePath: "company/filler", scanStatus: "skipped" }).returning({ id: companyAttachments.id });
    await expect(uploadCompanyAttachment(admin, companyId, { name: "one-more.txt", type: "text/plain", bytes: Buffer.alloc(100, 65) })).rejects.toThrow(/allowance/);
    await db.delete(companyAttachments).where(eq(companyAttachments.id, filler.id));
  });

  it("edits caption, site, tags and name (keeping the extension), and audits it", async () => {
    await updateAttachment(admin, docId, { caption: "Ground floor", siteId, tags: ["floor plan", " cabling ", ""], fileName: "ground-floor" });
    const row = (await getAttachment(docId))!;
    expect(row).toMatchObject({ caption: "Ground floor", siteId, tags: ["floor plan", "cabling"], fileName: "ground-floor.pdf" });
    await expect(updateAttachment(admin, docId, { siteId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/does not belong/);
  });

  it("removes and restores, hides removed files by default, and purges bytes after the retention period", async () => {
    await deleteAttachment(admin, docId);
    expect((await listCompanyAttachments(companyId)).some((a) => a.id === docId)).toBe(false);
    const withDeleted = await listCompanyAttachments(companyId, { includeDeleted: true });
    expect(withDeleted.find((a) => a.id === docId)).toMatchObject({ deletedByName: "Files Admin" });
    expect((await companyAttachmentUsage(companyId)).count).toBe(2);
    await deleteAttachment(admin, docId, true);
    expect((await getAttachment(docId))!.deletedAt).toBeNull();

    // Remove again, backdate the removal, and purge.
    await deleteAttachment(admin, docId);
    const row = (await getAttachment(docId))!;
    const abs = path.join(ATTACHMENT_ROOT, row.storagePath);
    expect(existsSync(abs)).toBe(true);
    expect(await purgeDeletedAttachments()).toBe(0);
    await db.update(companyAttachments).set({ deletedAt: new Date(Date.now() - (ATTACHMENT_LIMITS.purgeDays + 1) * 86400000) }).where(eq(companyAttachments.id, docId));
    expect(await purgeDeletedAttachments()).toBe(1);
    expect(await getAttachment(docId)).toBeNull();
    expect(existsSync(abs)).toBe(false);
    // The photo was never removed and is untouched.
    expect(await getAttachment(photoId)).not.toBeNull();
  });
});
