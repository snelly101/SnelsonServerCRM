import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { ExportLink } from "@/components/ui/export-link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { listContacts } from "@/services/contacts";
import { listSavedViews } from "@/services/settings";
import { PageHeader, Card, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, ROLE_LABELS_CONTACT } from "@/components/ui/badge";
import { Pagination, SortLink } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { param, toInt, fullName } from "@/lib/utils";

export const metadata = { title: "Contacts" };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("contact.read");
  const sp = await searchParams;
  const [data, views] = await Promise.all([
    listContacts({
      q: param(sp, "q"),
      role: param(sp, "role"),
      companyId: param(sp, "companyId"),
      sort: param(sp, "sort"),
      dir: param(sp, "dir") === "desc" ? "desc" : "asc",
      page: toInt(param(sp, "page"), 1),
    }),
    listSavedViews(me.id, "contacts"),
  ]);
  const hasFilters = Object.keys(sp).some((k) => !["page", "sort", "dir"].includes(k));

  return (
    <>
      <PageHeader
        title="Contacts"
        description="People at your prospects and customers."
        actions={
          <>
            {can(me.role, "company.export") && (
              <ExportLink href="/api/export/contacts" />
            )}
            {can(me.role, "company.import") && (
              <ButtonLink href="/companies/import?tab=contacts" variant="secondary">
                <Upload className="h-4 w-4" /> Import
              </ButtonLink>
            )}
            {can(me.role, "contact.write") && (
              <ButtonLink href="/contacts/new">
                <Plus className="h-4 w-4" /> New contact
              </ButtonLink>
            )}
          </>
        }
      />
      <FilterBar
        page="contacts"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search name, email, phone, company…"
        filters={[{ key: "role", label: "Role", options: Object.entries(ROLE_LABELS_CONTACT).map(([value, label]) => ({ value, label })) }]}
      />
      {data.total === 0 ? (
        <EmptyState title={hasFilters ? "No contacts match" : "No contacts yet"} description={hasFilters ? "Try a different search." : "Contacts belong to a company. Create the company first, then add its people."} />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>
                    <SortLink column="name" label="Name" />
                  </th>
                  <th>
                    <SortLink column="company" label="Company" />
                  </th>
                  <th>Roles</th>
                  <th>
                    <SortLink column="email" label="Email" />
                  </th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline">
                        {fullName(c)}
                      </Link>
                      {c.jobTitle && <div className="text-xs text-slate-500">{c.jobTitle}</div>}
                    </td>
                    <td>
                      <Link href={`/companies/${c.companyId}`} className="hover:underline">
                        {c.companyName}
                      </Link>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {c.isPrimary && <Badge tone="green">primary</Badge>}
                        {c.roles.map((r) => (
                          <Badge key={r}>{ROLE_LABELS_CONTACT[r]}</Badge>
                        ))}
                      </div>
                    </td>
                    <td>{c.email ?? "—"}</td>
                    <td>{c.mobile ?? c.phone ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
        </Card>
      )}
    </>
  );
}
