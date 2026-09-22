import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { listOwners } from "@/services/companies";
import { companyOptions, productOptions, siteOptions } from "@/services/lookups";
import { createContractAction } from "@/actions/contracts";
import { PageHeader, Card } from "@/components/ui/page";
import { ContractForm } from "@/components/contract-form";

export const metadata = { title: "New contract" };

export default async function NewContractPage({ searchParams }: { searchParams: Promise<{ companyId?: string }> }) {
  await requirePermission("contract.write");
  const { companyId } = await searchParams;
  const [companies, owners, products, settings, sites] = await Promise.all([companyOptions(), listOwners(), productOptions(), getAppSettings(), companyId ? siteOptions(companyId) : Promise.resolve([])]);
  return (
    <>
      <PageHeader title="New contract" breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: "New" }]} />
      <Card className="max-w-5xl">
        <ContractForm action={createContractAction} initial={{ companyId }} lines={[]} companies={companies} sites={sites} owners={owners} products={products} currency={settings.currency} cancelHref={companyId ? `/companies/${companyId}` : "/contracts"} />
      </Card>
    </>
  );
}
