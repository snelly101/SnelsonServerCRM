import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/action-result";
import { currentPortalAccount } from "@/lib/portal-auth";
import { portalReply } from "@/services/portal";
import { readUploads } from "@/lib/portal-uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await currentPortalAccount();
  if (!account) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const fd = await req.formData();
  const body = typeof fd.get("body") === "string" ? (fd.get("body") as string) : "";
  try {
    const { files, refused } = await readUploads(fd);
    const r = await portalReply(account, id, body, files);
    return NextResponse.json({ messageId: r.messageId, refused: [...refused, ...r.refused] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ActionError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "Could not send your reply." }, { status: 500 });
  }
}
