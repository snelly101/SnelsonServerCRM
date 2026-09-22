import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { getContract } from "@/services/contracts";
import { listOwners } from "@/services/companies";
import { productOptions, siteOptions } from "@/services/lookups";
import { updateContractAction } from "@/actions/contracts";
import { PageHeader, Card } from "@/components/ui/page";
import { ContractForm } from "@/components/contract-form";

export const metadata = { title: "Edit contract" };

export default async function EditContractPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("contract.write");
  const { id } = await params;
  const contract = await getContract(id);
  if (!contract) notFound();
  const [owners, products, settings, sites] = await Promise.all([listOwners(), productOptions(), getAppSettings(), siteOptions(contract.companyId)]);
  return (
    <>
      <PageHeader title={`Edit ${contract.name}`} breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: contract.name, href: `/contracts/${id}` }, { label: "Edit" }]} />
      <Card className="max-w-5xl">
        <ContractForm
          action={updateContractAction.bind(null, id)}
          initial={contract}
          lines={contract.lines.map((l) => ({ key: l.id, productId: l.productId ?? "", description: l.description, revenueType: l.revenueType, pricingModel: l.pricingModel, billingFrequency: l.billingFrequency, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), unitCost: l.unitCost === null ? null : Number(l.unitCost), siteId: l.siteId ?? "", countsAsManagedDevice: l.countsAsManagedDevice }))}
          companies={[{ id: contract.companyId, name: contract.companyName }]}
          sites={sites}
          owners={owners}
          products={products}
          currency={settings.currency}
          cancelHref={`/contracts/${id}`}
        />
      </Card>
    </>
  );
}
