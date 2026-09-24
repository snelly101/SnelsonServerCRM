import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can, ROLE_LABELS, type Role } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { listUsers } from "@/services/users";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { SecuritySettingsForm } from "./form";

export const metadata = { title: "Security" };

export default async function SecuritySettingsPage() {
  const me = await requirePermission("settings.read");
  const [settings, users] = await Promise.all([getAppSettings(), listUsers()]);
  const required = new Set(settings.twoFactorRequiredRoles);
  const active = users.filter((u) => u.active);
  const outstanding = active.filter((u) => required.has(u.role) && !u.twoFactorEnabled);
  return (
    <div className="space-y-4">
      <Card title="Two-factor authentication policy" className="max-w-2xl">
        <SecuritySettingsForm requiredRoles={settings.twoFactorRequiredRoles} deadline={settings.twoFactorDeadline} readOnly={!can(me.role, "settings.write")} />
      </Card>
      <Card title={`Enrolment · ${active.filter((u) => u.twoFactorEnabled).length} of ${active.length} active users`} padded={false}>
        <table className="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Two-factor</th>
            </tr>
          </thead>
          <tbody>
            {active.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td>{ROLE_LABELS[u.role as Role]}</td>
                <td>{u.twoFactorEnabled ? <Badge tone="green">on</Badge> : required.has(u.role) ? <Badge tone="amber">required, not set up</Badge> : <Badge>off</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          {outstanding.length ? `${outstanding.length} user${outstanding.length === 1 ? "" : "s"} still need to enrol. ` : "Everyone covered by the policy has enrolled. "}
          Lost phone? Reset a user&apos;s second factor from <Link href="/settings/users" className="text-brand-700 hover:underline">Users &amp; roles</Link>. Users who sign in with Microsoft only are covered by Entra multi-factor authentication and are not counted.
        </p>
      </Card>
    </div>
  );
}
