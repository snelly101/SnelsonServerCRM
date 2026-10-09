import { NextResponse } from "next/server";
import { ActionError } from "@/lib/action-result";
import { can } from "@/lib/permissions";
import { getCurrentUser, getRequestContext } from "@/lib/session";
import { exportVault } from "@/services/vault-backup";

export const dynamic = "force-dynamic";

/**
 * POST (form fields: reason, acknowledgement, passphrase?) → the backup ZIP as
 * a download. A POST so no secret, passphrase or reason ever sits in a URL or
 * access log. Errors come back as JSON for the dialog to show.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Signed out" }, { status: 401 });
  if (!can(user.role, "vault.admin")) return NextResponse.json({ error: "Only administrators can export the vault." }, { status: 403 });
  const fd = await req.formData();
  const text = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : "";
  };
  try {
    const ctx = await getRequestContext();
    const r = await exportVault({ id: user.id, name: user.name, role: user.role, ...ctx }, { reason: text("reason"), acknowledgement: text("acknowledgement"), passphrase: text("passphrase") || null });
    return new NextResponse(new Uint8Array(r.body), {
      headers: {
        "Content-Type": r.contentType,
        "Content-Disposition": `attachment; filename="${r.filename}"`,
        "Cache-Control": "no-store",
        "X-Vault-Export": JSON.stringify({ items: r.items, archived: r.archived, companies: r.companies, failed: r.failed, sha256: r.sha256, encrypted: r.encrypted, notified: r.notified, filename: r.filename }),
      },
    });
  } catch (err) {
    if (err instanceof ActionError) {
      const stepUp = err.message === "STEP_UP_REQUIRED";
      return NextResponse.json({ error: stepUp ? "Confirm your password again (it must be within the last 5 minutes)." : err.message, stepUpRequired: stepUp }, { status: err.message.includes("limit") ? 429 : 400 });
    }
    return NextResponse.json({ error: "The export failed. Nothing was downloaded." }, { status: 500 });
  }
}
