import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/action-result";
import { can } from "@/lib/permissions";
import { getCurrentUser } from "@/lib/session";
import { MAX_ATTACHMENT_BYTES } from "@/lib/email/storage";
import { uploadCompanyAttachment } from "@/services/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_FILES = 20;

/**
 * POST multipart: companyId, optional siteId and caption, and one or more
 * `files`. Each file is stored independently so one bad file does not fail
 * the batch; the response lists what was stored and what was refused.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Signed out" }, { status: 401 });
  if (!can(me.role, "company.write")) return NextResponse.json({ error: "You cannot add files to companies." }, { status: 403 });
  const fd = await req.formData();
  const text = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : "";
  };
  const parsed = z.object({ companyId: z.uuid(), siteId: z.uuid().optional().or(z.literal("")), caption: z.string().max(500).optional() }).safeParse({ companyId: text("companyId"), siteId: text("siteId"), caption: text("caption") });
  if (!parsed.success) return NextResponse.json({ error: "Missing company." }, { status: 400 });
  const files = fd.getAll("files").filter((f): f is File => f instanceof File).slice(0, MAX_FILES);
  if (!files.length) return NextResponse.json({ error: "Choose at least one file." }, { status: 400 });
  const stored: { id: string; fileName: string; isImage: boolean }[] = [];
  const refused: { fileName: string; error: string }[] = [];
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      refused.push({ fileName: f.name, error: `larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB` });
      continue;
    }
    try {
      const r = await uploadCompanyAttachment({ id: me.id, name: me.name }, parsed.data.companyId, { name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) }, { caption: parsed.data.caption || null, siteId: parsed.data.siteId || null });
      stored.push({ id: r.id, fileName: r.fileName, isImage: r.isImage });
    } catch (err) {
      refused.push({ fileName: f.name, error: err instanceof ActionError ? err.message : "could not be stored" });
    }
  }
  return NextResponse.json({ stored, refused }, { headers: { "Cache-Control": "no-store" } });
}
