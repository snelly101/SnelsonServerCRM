import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { exportCompaniesCsv, exportContactsCsv } from "@/services/csv";
import { audit } from "@/lib/audit";

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!can(user.role, "company.export")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { kind } = await ctx.params;
  let csv: string;
  if (kind === "companies") csv = await exportCompaniesCsv();
  else if (kind === "contacts") csv = await exportContactsCsv();
  else return NextResponse.json({ error: "Unknown export" }, { status: 404 });
  await audit({ actorUserId: user.id, action: `${kind.slice(0, -1) === "companie" ? "company" : "contact"}.export`, entityType: kind });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-${stamp}.csv"`,
    },
  });
}
