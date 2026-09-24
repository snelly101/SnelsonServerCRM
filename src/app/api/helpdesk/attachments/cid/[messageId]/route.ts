import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ticketAttachments } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { readAttachmentBytes } from "@/lib/email/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Inline image for an e-mail body (`cid:` reference), served only to signed-in helpdesk users and only for image types. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ messageId: string }> },
) {
  const me = await getCurrentUser();
  if (!me || !can(me.role, "helpdesk.read"))
    return new NextResponse("Forbidden", { status: 403 });
  const { messageId } = await ctx.params;
  const cid = req.nextUrl.searchParams.get("cid")?.replace(/^<|>$/g, "");
  if (!cid) return new NextResponse("Not found", { status: 404 });
  const [a] = await db
    .select()
    .from(ticketAttachments)
    .where(
      and(
        eq(ticketAttachments.messageId, messageId),
        eq(ticketAttachments.contentId, cid),
      ),
    )
    .limit(1);
  if (
    !a?.storagePath ||
    a.scanStatus === "blocked" ||
    a.scanStatus === "pending" ||
    a.scanStatus === "error" ||
    !/^image\//i.test(a.contentType)
  )
    return new NextResponse("Not found", { status: 404 });
  try {
    const bytes = await readAttachmentBytes(a.storagePath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": a.contentType,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
