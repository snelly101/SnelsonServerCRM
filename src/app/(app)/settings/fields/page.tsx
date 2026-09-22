import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { listTags } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { deleteCustomFieldAction, deleteTagAction } from "@/actions/admin";
import { CustomFieldForm, TagForm } from "./forms";

export const metadata = { title: "Tags & custom fields" };

export default async function FieldsPage() {
  const me = await requirePermission("settings.read");
  const canWrite = can(me.role, "settings.write");
  const [tags, defs] = await Promise.all([listTags(), listCustomFieldDefs()]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Tags">
        {tags.length === 0 ? <p className="text-sm text-slate-500">No tags yet.</p> : null}
        <ul className="mb-4 flex flex-wrap gap-2">
          {tags.map((t) => (
            <li key={t.id} className="inline-flex items-center gap-1">
              <Badge tone={t.color}>{t.name}</Badge>
              {canWrite && (
                <ConfirmButton variant="ghost" size="sm" action={deleteTagAction.bind(null, t.id)} title={`Delete tag "${t.name}"?`} description="It will be removed from every company." confirmLabel="Delete" className="h-6 px-1 text-xs">
                  ×
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
        {canWrite && <TagForm />}
      </Card>
      <Card title="Custom fields">
        {defs.length === 0 ? <p className="mb-3 text-sm text-slate-500">No custom fields yet. They appear on the company or contact form once defined.</p> : null}
        {defs.length > 0 && (
          <table className="tbl mb-4">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Label</th>
                <th>Key</th>
                <th>Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => (
                <tr key={d.id}>
                  <td>{d.entity}</td>
                  <td>
                    {d.label}
                    {d.required && <span className="ml-1 text-red-600">*</span>}
                  </td>
                  <td>
                    <code className="text-xs">{d.key}</code>
                  </td>
                  <td>
                    {d.type}
                    {d.options?.length ? <span className="text-xs text-slate-500"> ({d.options.join(", ")})</span> : null}
                  </td>
                  <td className="text-right">
                    {canWrite && (
                      <ConfirmButton variant="ghost" size="sm" action={deleteCustomFieldAction.bind(null, d.id)} title={`Delete field "${d.label}"?`} description="Existing values stay in the database but will no longer be shown." confirmLabel="Delete">
                        Delete
                      </ConfirmButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canWrite && <CustomFieldForm />}
      </Card>
    </div>
  );
}
