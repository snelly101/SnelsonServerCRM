import { requirePermission } from "@/lib/session";
import { listOwners, listTags } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { createCompanyAction } from "@/actions/companies";
import { PageHeader, Card } from "@/components/ui/page";
import { CompanyForm } from "@/components/company-form";

export const metadata = { title: "New company" };

export default async function NewCompanyPage() {
  await requirePermission("company.write");
  const [owners, tags, defs] = await Promise.all([listOwners(), listTags(), listCustomFieldDefs("company")]);
  return (
    <>
      <PageHeader title="New company" breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: "New" }]} />
      <Card className="max-w-3xl">
        <CompanyForm action={createCompanyAction} initial={{}} owners={owners} tags={tags} customFieldDefs={defs} cancelHref="/companies" />
      </Card>
    </>
  );
}
