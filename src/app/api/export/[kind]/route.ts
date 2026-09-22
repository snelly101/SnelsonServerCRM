import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { exportCompaniesCsv, exportContactsCsv } from "@/services/csv";
import { audit } from "@/lib/audit";
import { exportReportCsv, REPORT_EXPORTS, type ReportExport } from "@/services/reports";

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { kind } = await ctx.params;
  let csv: string;
  if (kind.startsWith("report-")) {
    const report = kind.slice("report-".length) as ReportExport;
    if (!REPORT_EXPORTS.includes(report)) return NextResponse.json({ error: "Unknown export" }, { status: 404 });
    const needed = report === "outstanding-invoices" ? "report.finance.read" : "report.read";
    if (!can(user.role, needed)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    csv = await exportReportCsv(report);
    await audit({ actorUserId: user.id, action: "report.export", entityType: "report", entityId: report });
  } else {
    if (!can(user.role, "company.export")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (kind === "companies") csv = await exportCompaniesCsv();
    else if (kind === "contacts") csv = await exportContactsCsv();
    else return NextResponse.json({ error: "Unknown export" }, { status: 404 });
    await audit({ actorUserId: user.id, action: `${kind === "companies" ? "company" : "contact"}.export`, entityType: kind });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-${stamp}.csv"`,
    },
  });
}
