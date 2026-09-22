import { requirePermission } from "@/lib/session";
import { listTemplates } from "@/services/onboarding";
import { PageHeader, Card } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { archiveTemplateAction } from "@/actions/tasks";
import { TemplateDialog } from "./template-dialog";
import { ROLE_LABELS, type Role } from "@/lib/permissions";

export const metadata = { title: "Checklist templates" };

export default async function TemplatesPage() {
  await requirePermission("settings.write");
  const templates = await listTemplates();
  return (
    <>
      <PageHeader title="Checklist templates" description="Reusable onboarding checklists. The default one is created automatically when an opportunity is won or a proposal is accepted." breadcrumbs={[{ label: "Tasks & Onboarding", href: "/tasks" }, { label: "Templates" }]} actions={<TemplateDialog />} />
      <div className="grid gap-4 lg:grid-cols-2">
        {templates.map((t) => (
          <Card
            key={t.id}
            title={
              <span className="flex items-center gap-2">
                {t.name}
                {t.isDefaultOnboarding && <Badge tone="green">default</Badge>}
              </span>
            }
            actions={
              <>
                <TemplateDialog template={t} />
                <ConfirmButton variant="ghost" size="sm" action={archiveTemplateAction.bind(null, t.id)} title={`Archive template "${t.name}"?`} confirmLabel="Archive">
                  Archive
                </ConfirmButton>
              </>
            }
          >
            {t.description && <p className="mb-2 text-sm text-slate-600">{t.description}</p>}
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {t.items.map((i) => (
                <li key={i.id}>
                  {i.title} <span className="text-xs text-slate-500">· day {i.dueOffsetDays}{i.defaultOwnerRole ? ` · ${ROLE_LABELS[i.defaultOwnerRole as Role] ?? i.defaultOwnerRole}` : ""}</span>
                </li>
              ))}
            </ol>
          </Card>
        ))}
      </div>
    </>
  );
}
