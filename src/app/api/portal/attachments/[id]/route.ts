import { NextResponse, type NextRequest } from "next/server";
import { readAttachmentBytes } from "@/lib/email/storage";
import { currentPortalAccount } from "@/lib/portal-auth";
import { portalAttachment } from "@/services/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Customer download: only attachments on a ticket the account may see, never restricted or unscanned ones, always as a sandboxed download. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const account = await currentPortalAccount();
  if (!account) return new NextResponse("Sign in", { status: 401 });
  const { id } = await ctx.params;
  const a = await portalAttachment(account, id);
  if (!a || !a.storagePath) return new NextResponse("Not found", { status: 404 });
  let bytes: Buffer;
  try {
    bytes = await readAttachmentBytes(a.storagePath);
  } catch {
    return new NextResponse("This file is no longer available.", { status: 410 });
  }
  const safeName = a.fileName.replace(/[\r\n"]/g, "_");
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/i.test(a.contentType) ? a.contentType : "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
