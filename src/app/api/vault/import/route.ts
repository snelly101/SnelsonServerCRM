import { NextResponse } from "next/server";
import { ActionError } from "@/lib/action-result";
import { can } from "@/lib/permissions";
import { getCurrentUser, getRequestContext } from "@/lib/session";
import { importVaultBackup } from "@/services/vault-backup";

export const dynamic = "force-dynamic";
const MAX_BYTES = 50 * 1024 * 1024;

/** POST multipart (file, reason, acknowledgement) → import summary JSON. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Signed out" }, { status: 401 });
  if (!can(user.role, "vault.admin")) return NextResponse.json({ error: "Only administrators can import a vault backup." }, { status: 403 });
  const fd = await req.formData();
  const file = fd.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Choose the vault-backup.json file." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That file is too large (50 MB limit)." }, { status: 413 });
  const text = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : "";
  };
  try {
    const ctx = await getRequestContext();
    const r = await importVaultBackup({ id: user.id, name: user.name, role: user.role, ...ctx }, { json: await file.text(), reason: text("reason"), acknowledgement: text("acknowledgement") });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ActionError) {
      const stepUp = err.message === "STEP_UP_REQUIRED";
      return NextResponse.json({ error: stepUp ? "Confirm your password again (it must be within the last 5 minutes)." : err.message, stepUpRequired: stepUp }, { status: 400 });
    }
    return NextResponse.json({ error: "The import failed. Check the file and try again." }, { status: 500 });
  }
}
