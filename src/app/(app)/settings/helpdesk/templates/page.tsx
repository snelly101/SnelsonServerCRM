import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { listTemplates, TEMPLATE_PLACEHOLDERS } from "@/services/helpdesk-collab";
import { PageHeader, Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { deleteTemplateAction } from "@/actions/helpdesk-admin";
import { markdownExcerpt } from "@/lib/markdown-parse";
import { TemplateDialog } from "./forms";

export const metadata = { title: "Response templates" };

export default async function TemplatesAdminPage() {
  await requirePermission("helpdesk.manage");
  const templates = await listTemplates();
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/settings/helpdesk" className="hover:text-slate-800">
          Helpdesk settings
        </Link>{" "}
        / Response templates
      </nav>
      <PageHeader
        title="Response templates"
        description={`Canned replies and note templates agents insert from the composer. Placeholders: ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}.`}
        actions={<TemplateDialog />}
      />
      <Card padded={false}>
        {templates.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No templates yet. A good start: “Password reset done”, “Need more
            information”, “Resolved, closing in 5 days”.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {templates.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge tone={t.scope === "internal" ? "amber" : t.scope === "both" ? "purple" : "blue"}>
                      {t.scope === "internal" ? "note" : t.scope === "both" ? "reply or note" : "reply"}
                    </Badge>
                    {t.category && <span className="text-xs text-slate-500">{t.category}</span>}
                    {!t.active && <Badge tone="slate">inactive</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{markdownExcerpt(t.body, 140)}</p>
                </div>
                <TemplateDialog template={t} />
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  action={deleteTemplateAction.bind(null, t.id)}
                  title={`Delete template ${t.name}?`}
                  confirmLabel="Delete"
                >
                  Delete
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
