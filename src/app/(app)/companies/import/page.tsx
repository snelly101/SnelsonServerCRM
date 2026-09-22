import { requirePermission } from "@/lib/session";
import { PageHeader, Card } from "@/components/ui/page";
import { ImportForm } from "@/components/import-form";
import { importCompaniesAction, importContactsAction } from "@/actions/csv";
import { COMPANY_CSV_COLUMNS, CONTACT_CSV_COLUMNS } from "@/services/csv";

export const metadata = { title: "Import CSV" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requirePermission("company.import");
  const { tab } = await searchParams;
  return (
    <>
      <PageHeader
        title="Import from CSV"
        description="Rows that look like duplicates are skipped and reported, never merged. Nothing is overwritten."
        breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: "Import" }]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Companies">
          <ImportForm action={importCompaniesAction} columns={COMPANY_CSV_COLUMNS} sample={`name,status,website,industry,email,city,postcode\nAcme Widgets Ltd,prospect,acmewidgets.co.uk,Manufacturing,info@acmewidgets.co.uk,Leeds,LS1 1AA`} autoFocus={tab !== "contacts"} />
        </Card>
        <Card title="Contacts">
          <ImportForm action={importContactsAction} columns={CONTACT_CSV_COLUMNS} sample={`companyName,firstName,lastName,email,jobTitle,roles\nAcme Widgets Ltd,Jane,Smith,jane@acmewidgets.co.uk,Operations Director,decision_maker;billing`} autoFocus={tab === "contacts"} />
        </Card>
      </div>
    </>
  );
}
