import { requirePermission } from "@/lib/session";
import { listUsers } from "@/services/users";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS, ROLES, actionsForRole } from "@/lib/permissions";
import { CreateUserForm, EditUserDialog, ResetTwoFactorButton } from "./forms";

export const metadata = { title: "Users & roles" };

export default async function UsersPage() {
  const me = await requirePermission("user.manage");
  const users = await listUsers();
  return (
    <div className="space-y-4">
      <Card title="Staff accounts" padded={false}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Two-factor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="font-medium">
                  {u.name}
                  {u.id === me.id && <span className="ml-1 text-xs text-slate-500">(you)</span>}
                </td>
                <td>{u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{u.active ? <Badge tone="green">active</Badge> : <Badge>disabled</Badge>}</td>
                <td>{u.twoFactorEnabled ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</td>
                <td className="text-right">
                  <span className="inline-flex items-center gap-1">
                    {u.twoFactorEnabled && <ResetTwoFactorButton userId={u.id} name={u.name} />}
                    <EditUserDialog user={u} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Add a staff account" className="max-w-xl">
        <CreateUserForm />
      </Card>
      <Card title="What each role can do">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ROLES.map((r) => (
            <div key={r} className="rounded-md border border-slate-200 p-3">
              <div className="mb-1 text-sm font-semibold">{ROLE_LABELS[r]}</div>
              <div className="flex flex-wrap gap-1">
                {actionsForRole(r).map((a) => (
                  <code key={a} className="rounded bg-slate-100 px-1 text-[11px]">
                    {a}
                  </code>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
