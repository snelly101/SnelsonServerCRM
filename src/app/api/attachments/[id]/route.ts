import { NextResponse, type NextRequest } from "next/server";
import { can } from "@/lib/permissions";
import { getCurrentUser } from "@/lib/session";
import { audit } from "@/lib/audit";
import { readAttachment } from "@/services/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/i;

/**
 * Authorised download. `?v=thumb` serves the WebP thumbnail (cacheable in
 * the browser, it is ours and immutable); `?v=inline` shows safe types in
 * the browser; anything else is a download. Every request checks the
 * session and company.read, and the CSP sandbox stops an HTML or SVG file
 * from running in the app origin.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me || !can(me.role, "company.read")) return new NextResponse("Forbidden", { status: 403 });
  const { id } = await ctx.params;
  const variant = req.nextUrl.searchParams.get("v");
  let hit: Awaited<ReturnType<typeof readAttachment>>;
  try {
    hit = await readAttachment(id, variant === "thumb" ? "thumb" : "original");
  } catch {
    return new NextResponse("Attachment content is missing from storage.", { status: 410 });
  }
  if (!hit) return new NextResponse("Not found", { status: 404 });
  const { row, bytes, contentType } = hit;
  if (row.scanStatus === "blocked") return new NextResponse("This file was blocked by the virus scanner.", { status: 403 });
  if (row.scanStatus === "pending" || row.scanStatus === "error") return new NextResponse("This file has not been scanned yet.", { status: 409 });
  if (variant !== "thumb") await audit({ actorUserId: me.id, action: "attachment.download", entityType: "company_attachment", entityId: row.id, details: { companyId: row.companyId, fileName: row.fileName, inline: variant === "inline" } });
  const safeName = row.fileName.replace(/[\r\n"]/g, "_");
  const type = INLINE_TYPES.test(contentType) ? contentType : "application/octet-stream";
  const inline = variant === "thumb" || (variant === "inline" && INLINE_TYPES.test(contentType));
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": variant === "thumb" ? "private, max-age=86400" : "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
