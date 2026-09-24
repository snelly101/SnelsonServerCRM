import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  exportHelpdeskCsv,
  HELPDESK_EXPORTS,
  parseRange,
  type HelpdeskExport,
} from "@/services/helpdesk-reports";

/** CSV exports for the helpdesk reports (helpdesk.manage). Same filters as the page. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ kind: string }> },
) {
  const user = await getCurrentUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!can(user.role, "helpdesk.manage"))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { kind } = await ctx.params;
  if (!(HELPDESK_EXPORTS as readonly string[]).includes(kind))
    return NextResponse.json({ error: "Unknown export" }, { status: 404 });
  const sp = new URL(req.url).searchParams;
  const range = parseRange(sp.get("from"), sp.get("to"));
  const filters = {
    ...range,
    companyId: sp.get("companyId") || null,
    assigneeUserId: sp.get("assigneeUserId") || null,
    teamId: sp.get("teamId") || null,
    categoryId: sp.get("categoryId") || null,
    priority: sp.get("priority") || null,
  };
  const csv = await exportHelpdeskCsv(kind as HelpdeskExport, filters);
  await audit({
    actorUserId: user.id,
    action: "helpdesk.export",
    entityType: "helpdesk_report",
    entityId: kind,
    details: { from: range.from.toISOString(), to: range.to.toISOString() },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="helpdesk-${kind}-${stamp}.csv"`,
    },
  });
}
