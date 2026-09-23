import Link from "next/link";
import { sql, eq } from "drizzle-orm";
import { db } from "@/db";
import { vaultCategories, vaultItems } from "@/db/schema";
import { requirePermission } from "@/lib/session";
import { getSystemStatus } from "@/lib/system-status";
import { listUsers } from "@/services/users";
import { companyOptions } from "@/services/lookups";
import { listGrants, vaultHealth, vaultSettings } from "@/services/vault";
import { Card, DescriptionList } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { CategoryForm, CategoryList, GrantsTable, MaintenanceButtons, VaultSettingsForm } from "./controls";

export const metadata = { title: "Secure Vault settings" };
export const dynamic = "force-dynamic";

export default async function VaultSettingsPage() {
  await requirePermission("vault.admin");
  const [grants, users, companies, settings, health, chain, categories] = await Promise.all([
    listGrants(),
    listUsers(),
    companyOptions(),
    vaultSettings(),
    vaultHealth(),
    getSystemStatus<{ ok: boolean; checked: number; brokenAt: number | null }>("vault.chain"),
    db.select({ id: vaultCategories.id, name: vaultCategories.name, isSystem: vaultCategories.isSystem, archivedAt: vaultCategories.archivedAt, itemCount: sql<number>`(select count(*) from vault_items i where i.category_id = vault_categories.id)`.mapWith(Number) }).from(vaultCategories).orderBy(vaultCategories.sortOrder, vaultCategories.name),
  ]);
  const eligible = users.filter((u) => u.active && (u.role === "technician" || u.role === "admin")).map((u) => ({ id: u.id, name: u.name, role: u.role }));
  void eq;
  void vaultItems;
  return (
    <div className="space-y-4">
      {!health.configured && (
        <Alert tone="error" title="Vault master key not configured">
          Set <code>VAULT_MASTER_KEY</code> (32 bytes, base64) in <code>.env</code> for the web service and restart. Until then items can be listed but not created or revealed.
        </Alert>
      )}
      {health.configured && health.keyMatches === false && (
        <Alert tone="error" title="Vault master key mismatch">
          The configured key does not match the fingerprint recorded for version {health.keyVersion}. If you rotated the key, increase <code>VAULT_MASTER_KEY_VERSION</code> and put the old key in <code>VAULT_MASTER_KEY_PREVIOUS</code>.
        </Alert>
      )}
      {chain && chain.value.ok === false && (
        <Alert tone="error" title="Audit chain integrity failure">
          The nightly check found a broken link at entry {chain.value.brokenAt}. Entries from that point cannot be trusted. Investigate database access immediately.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Status">
          <DescriptionList
            items={[
              { label: "Master key", value: health.configured ? <Badge tone={health.keyMatches ? "green" : "red"}>{health.keyMatches ? `present · version ${health.keyVersion}` : "mismatch"}</Badge> : <Badge tone="red">missing</Badge> },
              { label: "Items stored", value: health.items },
              { label: "Audit chain", value: chain ? <span><Badge tone={chain.value.ok ? "green" : "red"}>{chain.value.ok ? "intact" : "BROKEN"}</Badge> <span className="text-xs text-slate-500">{chain.value.checked} entries, checked {chain.updatedAt.toLocaleString("en-GB")}</span></span> : "not yet verified" },
              { label: "Audit log", value: <Link href="/settings/vault/audit" className="text-brand-700 hover:underline">Who revealed what, when</Link> },
            ]}
          />
          <div className="mt-4 border-t border-slate-100 pt-4"><MaintenanceButtons /></div>
          <p className="mt-3 text-xs text-slate-500">Key custody: the master key lives only in the web container&apos;s environment and in your password manager. Database backups hold ciphertext; without the key they cannot be read. See docs/deployment.md.</p>
        </Card>
        <Card title="Behaviour">
          <VaultSettingsForm settings={settings} />
        </Card>
      </div>

      <Card title={`Access grants · ${grants.length}`} padded={false}>
        <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">Administrators always have every capability. Technicians get exactly what is granted here, for all customers or one. Sales, finance and read-only roles can never hold vault access. Every change is recorded in the vault audit trail.</p>
        <GrantsTable grants={grants} users={eligible} companies={companies} />
      </Card>

      <Card title="Categories" padded={false}>
        <CategoryList categories={categories} />
        <div className="border-t border-slate-100 p-4"><CategoryForm /></div>
      </Card>
    </div>
  );
}
