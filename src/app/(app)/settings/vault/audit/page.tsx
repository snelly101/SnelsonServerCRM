import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { listUsers } from "@/services/users";
import { companyOptions } from "@/services/lookups";
import { listVaultAudit } from "@/services/vault";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Secure Vault audit" };
export const dynamic = "force-dynamic";

const ACTIONS = ["revealed", "copied", "totp_code", "created", "modified", "archived", "restored", "viewed", "grant_changed", "grant_revoked", "step_up_succeeded", "step_up_failed", "rate_limited", "rewrapped", "chain_verified", "category_changed"];
const TONE: Record<string, string> = { revealed: "amber", copied: "amber", totp_code: "amber", archived: "red", rate_limited: "red", step_up_failed: "red", created: "green", modified: "blue" };

export default async function VaultAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("vault.admin");
  const sp = await searchParams;
  const [users, companies] = await Promise.all([listUsers(), companyOptions()]);
  const data = await listVaultAudit({ id: me.id, name: me.name, role: me.role }, { companyId: param(sp, "company"), actorUserId: param(sp, "user"), action: param(sp, "action"), from: param(sp, "from"), to: param(sp, "to"), page: toInt(param(sp, "page"), 1) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        <Link href="/settings/vault" className="text-brand-700 hover:underline">Secure Vault</Link> · append-only audit trail. Secrets are never recorded; the free-text filter searches nothing here.
      </p>
      <FilterBar
        page="vault-audit"
        savedViews={[]}
        currentUserId={me.id}
        placeholder="(no text search)"
        filters={[
          { key: "company", label: "Customer", options: companies.map((c) => ({ value: c.id, label: c.name })) },
          { key: "user", label: "User", options: users.map((u) => ({ value: u.id, label: u.name })) },
          { key: "action", label: "Action", options: ACTIONS.map((a) => ({ value: a, label: a.replace(/_/g, " ") })) },
        ]}
      />
      <Card padded={false}>
        {data.rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No entries match.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Customer</th>
                <th>Item</th>
                <th>Field</th>
                <th>From</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-slate-500">{r.at.toLocaleString("en-GB")}</td>
                  <td>{r.actorName ?? <span className="text-slate-400">system</span>}</td>
                  <td><Badge tone={TONE[r.action] ?? "slate"}>{r.action.replace(/_/g, " ")}</Badge></td>
                  <td>{r.companyId ? <Link href={`/companies/${r.companyId}?tab=vault`} className="text-brand-700 hover:underline">{r.companyName ?? "customer"}</Link> : ""}</td>
                  <td>{r.itemName ?? ""}</td>
                  <td className="font-mono text-xs">{r.field ?? ""}</td>
                  <td className="font-mono text-xs text-slate-500" title={r.userAgent ?? ""}>{r.ipAddress ?? ""}</td>
                  <td className="max-w-md truncate text-xs text-slate-500" title={r.details ? JSON.stringify(r.details) : ""}>{r.details ? JSON.stringify(r.details) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
      </Card>
    </div>
  );
}
