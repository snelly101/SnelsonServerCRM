import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketAttachments } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { readAttachmentBytes } from "@/lib/email/storage";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authorised attachment download. Every request checks the session, the
 * helpdesk permission and the scan status; bytes never leave the data
 * volume otherwise. Content is served as a download with a fixed
 * content type so an HTML or SVG attachment cannot run in the app origin.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me || !can(me.role, "helpdesk.read"))
    return new NextResponse("Forbidden", { status: 403 });
  const { id } = await ctx.params;
  const [a] = await db
    .select()
    .from(ticketAttachments)
    .where(eq(ticketAttachments.id, id))
    .limit(1);
  if (!a || !a.storagePath)
    return new NextResponse("Not found", { status: 404 });
  if (a.scanStatus === "blocked")
    return new NextResponse(
      "This attachment was blocked by the virus scanner.",
      { status: 403 },
    );
  if (a.scanStatus === "pending" || a.scanStatus === "error")
    return new NextResponse("This attachment has not been scanned yet.", {
      status: 409,
    });
  let bytes: Buffer;
  try {
    bytes = await readAttachmentBytes(a.storagePath);
  } catch {
    return new NextResponse("Attachment content is missing from storage.", {
      status: 410,
    });
  }
  await audit({
    actorUserId: me.id,
    action: "ticket.attachment.download",
    entityType: "ticket_attachment",
    entityId: a.id,
    details: { ticketId: a.ticketId, fileName: a.fileName },
  });
  const safeName = a.fileName.replace(/[\r\n"]/g, "_");
  const inlineTypes =
    /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/i;
  const type = inlineTypes.test(a.contentType)
    ? a.contentType
    : "application/octet-stream";
  const disposition =
    _req.nextUrl.searchParams.get("inline") === "1" &&
    inlineTypes.test(a.contentType)
      ? "inline"
      : "attachment";
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
