import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, user } from "@/db/schema";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { Card } from "@/components/ui/page";
import { fmtDateTime } from "@/lib/format";
import { toInt } from "@/lib/utils";
import { Pagination } from "@/components/ui/pagination";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePermission("audit.read");
  const { page: p } = await searchParams;
  const page = toInt(p, 1);
  const pageSize = 50;
  const [rows, settings, [{ total }]] = await Promise.all([
    db
      .select({ id: auditLog.id, at: auditLog.at, action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId, details: auditLog.details, actor: user.name, actorType: auditLog.actorType })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.actorUserId))
      .orderBy(desc(auditLog.at))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    getAppSettings(),
    db.select({ total: db.$count(auditLog) }).from(auditLog).limit(1),
  ]);
  return (
    <Card title="Audit log" padded={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-slate-500">{fmtDateTime(r.at, settings)}</td>
                <td>{r.actor ?? (r.actorType === "system" ? "system" : "—")}</td>
                <td>
                  <code className="text-xs">{r.action}</code>
                </td>
                <td className="text-xs text-slate-600">
                  {r.entityType}
                  {r.entityId && <span className="text-slate-400"> {r.entityId.slice(0, 8)}</span>}
                </td>
                <td className="max-w-md truncate text-xs text-slate-600" title={r.details ? JSON.stringify(r.details) : ""}>
                  {r.details ? JSON.stringify(r.details) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} total={total} pageSize={pageSize} />
    </Card>
  );
}
