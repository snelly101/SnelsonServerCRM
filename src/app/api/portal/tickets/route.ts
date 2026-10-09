import { NextResponse } from "next/server";
import { ActionError } from "@/lib/action-result";
import { currentPortalAccount } from "@/lib/portal-auth";
import { portalCreateTicket } from "@/services/portal";
import { readUploads } from "@/lib/portal-uploads";
import type { TicketPriority } from "@/lib/validation-helpdesk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST multipart: subject, description, priority, files[] → { id, reference, refused }. */
export async function POST(req: Request) {
  const account = await currentPortalAccount();
  if (!account) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const fd = await req.formData();
  const text = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : "";
  };
  try {
    const { files, refused } = await readUploads(fd);
    const r = await portalCreateTicket(account, { subject: text("subject"), description: text("description"), priority: text("priority") as TicketPriority }, files);
    return NextResponse.json({ id: r.id, reference: r.reference, refused: [...refused, ...r.refused] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ActionError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "Could not create the request." }, { status: 500 });
  }
}
