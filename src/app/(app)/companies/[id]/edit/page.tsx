import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getCompany, listOwners, listTags } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { updateCompanyAction } from "@/actions/companies";
import { PageHeader, Card } from "@/components/ui/page";
import { CompanyForm } from "@/components/company-form";

export const metadata = { title: "Edit company" };

export default async function EditCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("company.write");
  const { id } = await params;
  const [company, owners, tags, defs] = await Promise.all([getCompany(id), listOwners(), listTags(), listCustomFieldDefs("company")]);
  if (!company) notFound();
  const bound = updateCompanyAction.bind(null, id);
  return (
    <>
      <PageHeader title={`Edit ${company.name}`} breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: company.name, href: `/companies/${id}` }, { label: "Edit" }]} />
      <Card className="max-w-3xl">
        <CompanyForm
          action={bound}
          initial={{ ...company, tagIds: company.tags.map((t) => t.id) }}
          owners={owners}
          tags={tags}
          customFieldDefs={defs}
          cancelHref={`/companies/${id}`}
        />
      </Card>
    </>
  );
}
