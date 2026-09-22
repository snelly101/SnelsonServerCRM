import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { ExportLink } from "@/components/ui/export-link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { listCompanies, listIndustries, listOwners, listTags } from "@/services/companies";
import { listSavedViews } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { PageHeader, Card, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, STATUS_TONES } from "@/components/ui/badge";
import { Pagination, SortLink } from "@/components/ui/pagination";
import { FilterBar } from "@/components/ui/filter-bar";
import { fmtDate } from "@/lib/format";
import { param, toInt } from "@/lib/utils";

export const metadata = { title: "Companies" };

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requirePermission("company.read");
  const sp = await searchParams;
  const [data, industries, owners, tags, views, settings] = await Promise.all([
    listCompanies({
      q: param(sp, "q"),
      status: param(sp, "status"),
      ownerUserId: param(sp, "owner"),
      tagId: param(sp, "tag"),
      industry: param(sp, "industry"),
      includeArchived: param(sp, "archived") === "1",
      sort: param(sp, "sort"),
      dir: param(sp, "dir") === "desc" ? "desc" : "asc",
      page: toInt(param(sp, "page"), 1),
    }),
    listIndustries(),
    listOwners(),
    listTags(),
    listSavedViews(me.id, "companies"),
    getAppSettings(),
  ]);
  const hasFilters = Object.keys(sp).some((k) => !["page", "sort", "dir"].includes(k));

  return (
    <>
      <PageHeader
        title="Companies"
        description="Prospects and customers."
        actions={
          <>
            {can(me.role, "company.export") && (
              <ExportLink href="/api/export/companies" />
            )}
            {can(me.role, "company.import") && (
              <ButtonLink href="/companies/import" variant="secondary">
                <Upload className="h-4 w-4" /> Import
              </ButtonLink>
            )}
            {can(me.role, "company.write") && (
              <ButtonLink href="/companies/new">
                <Plus className="h-4 w-4" /> New company
              </ButtonLink>
            )}
          </>
        }
      />
      <FilterBar
        page="companies"
        currentUserId={me.id}
        savedViews={views}
        placeholder="Search name, domain, postcode…"
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "prospect", label: "Prospect" },
              { value: "customer", label: "Customer" },
              { value: "former", label: "Former customer" },
              { value: "other", label: "Other" },
            ],
          },
          { key: "owner", label: "Owner", options: owners.map((o) => ({ value: o.id, label: o.name })) },
          { key: "industry", label: "Industry", options: industries.map((i) => ({ value: i, label: i })) },
          { key: "tag", label: "Tag", options: tags.map((t) => ({ value: t.id, label: t.name })) },
          { key: "archived", label: "Archived", options: [{ value: "1", label: "Include archived" }] },
        ]}
      />
      {data.total === 0 ? (
        <EmptyState
          title={hasFilters ? "No companies match these filters" : "No companies yet"}
          description={hasFilters ? "Try clearing a filter or searching for something else." : "Add your first prospect or import a CSV of existing customers."}
          action={can(me.role, "company.write") && !hasFilters ? <ButtonLink href="/companies/new">New company</ButtonLink> : undefined}
        />
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
                    <SortLink column="status" label="Status" />
                  </th>
                  <th>
                    <SortLink column="industry" label="Industry" />
                  </th>
                  <th>Location</th>
                  <th>Owner</th>
                  <th>Contacts</th>
                  <th>Tags</th>
                  <th>
                    <SortLink column="updatedAt" label="Updated" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.id} className={c.archivedAt ? "opacity-60" : ""}>
                    <td>
                      <Link href={`/companies/${c.id}`} className="font-medium text-brand-700 hover:underline">
                        {c.name}
                      </Link>
                      {c.domain && <div className="text-xs text-slate-500">{c.domain}</div>}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONES[c.status]}>{c.status}</Badge>
                      {c.archivedAt && <Badge className="ml-1">archived</Badge>}
                    </td>
                    <td>{c.industry ?? "—"}</td>
                    <td>{c.city ?? "—"}</td>
                    <td>{c.ownerName ?? "—"}</td>
                    <td>{c.contactCount}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {c.tags.map((t) => (
                          <Badge key={t.id} tone={t.color}>
                            {t.name}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="text-slate-500">{fmtDate(c.updatedAt, settings)}</td>
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
