import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { listCategories, listTeams } from "@/services/helpdesk";
import { listOwners } from "@/services/companies";
import { PageHeader, Card } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { deleteCategoryAction, deleteTeamAction } from "@/actions/helpdesk";
import { TeamDialog, CategoryDialog } from "./forms";

export const metadata = { title: "Helpdesk administration" };

export default async function HelpdeskAdminPage() {
  await requirePermission("helpdesk.admin");
  const [teams, categories, users] = await Promise.all([
    listTeams(),
    listCategories(),
    listOwners(),
  ]);
  return (
    <>
      <PageHeader
        title="Helpdesk administration"
        description="Teams, categories, the support mailbox and (in later stages) SLA policies and automation rules."
        actions={
          <ButtonLink href="/helpdesk/admin/mailbox" variant="secondary">
            Support mailbox
          </ButtonLink>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Teams"
          padded={false}
          actions={<TeamDialog users={users} />}
        >
          {teams.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">
              No teams yet. Teams give tickets a queue before an agent picks
              them up.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {teams.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start gap-3 px-4 py-2.5 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {t.name}{" "}
                      {!t.active && <Badge tone="slate">inactive</Badge>}
                    </div>
                    {t.description && (
                      <div className="text-xs text-slate-500">
                        {t.description}
                      </div>
                    )}
                    <div className="text-xs text-slate-500">
                      {t.members.length
                        ? t.members
                            .map((m) => `${m.name}${m.isLead ? " (lead)" : ""}`)
                            .join(", ")
                        : "no members"}
                    </div>
                  </div>
                  <TeamDialog
                    team={{
                      id: t.id,
                      name: t.name,
                      description: t.description,
                      active: t.active,
                      members: t.members.map((m) => ({
                        userId: m.userId,
                        isLead: m.isLead,
                      })),
                    }}
                    users={users}
                  />
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    action={deleteTeamAction.bind(null, t.id)}
                    title={`Delete team ${t.name}?`}
                    description="Tickets keep their history; their team field is cleared."
                    confirmLabel="Delete"
                  >
                    Delete
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Categories"
          padded={false}
          actions={
            <CategoryDialog
              parents={categories.map((c) => ({ id: c.id, name: c.name }))}
            />
          }
        >
          {categories.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">
              No categories yet. Categories drive routing rules and reports.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {categories.map((c) => (
                <li key={c.id} className="px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {!c.active && <Badge tone="slate">inactive</Badge>}
                    <span className="ml-auto flex gap-1">
                      <CategoryDialog parents={[]} parentId={c.id} />
                      <CategoryDialog
                        category={c}
                        parents={categories
                          .filter((p) => p.id !== c.id)
                          .map((p) => ({ id: p.id, name: p.name }))}
                      />
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        action={deleteCategoryAction.bind(null, c.id)}
                        title={`Delete ${c.name}?`}
                        description="Its subcategories are deleted too; tickets keep their history with the category cleared."
                        confirmLabel="Delete"
                      >
                        Delete
                      </ConfirmButton>
                    </span>
                  </div>
                  {c.children.length > 0 && (
                    <ul className="mt-1 space-y-0.5 pl-4 text-xs">
                      {c.children.map((s) => (
                        <li key={s.id} className="flex items-center gap-2">
                          <span>› {s.name}</span>
                          {!s.active && <Badge tone="slate">inactive</Badge>}
                          <span className="ml-auto flex gap-1">
                            <CategoryDialog
                              category={s}
                              parents={categories.map((p) => ({
                                id: p.id,
                                name: p.name,
                              }))}
                            />
                            <ConfirmButton
                              size="sm"
                              variant="ghost"
                              action={deleteCategoryAction.bind(null, s.id)}
                              title={`Delete ${s.name}?`}
                              confirmLabel="Delete"
                            >
                              Delete
                            </ConfirmButton>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Custom fields for tickets are managed under{" "}
        <Link
          href="/settings/fields"
          className="text-brand-700 hover:underline"
        >
          Settings → Tags &amp; custom fields
        </Link>{" "}
        (entity “Helpdesk ticket”).
      </p>
    </>
  );
}
