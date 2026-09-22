import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { getOpportunity, listLeadSources, listStages } from "@/services/opportunities";
import { listOwners } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { companyOptions, contactOptions, productOptions } from "@/services/lookups";
import { updateOpportunityAction } from "@/actions/sales";
import { PageHeader, Card } from "@/components/ui/page";
import { OpportunityForm } from "@/components/opportunity-form";

export const metadata = { title: "Edit opportunity" };

export default async function EditOpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("opportunity.write");
  const { id } = await params;
  const opp = await getOpportunity(id);
  if (!opp) notFound();
  if (opp.status !== "open") redirect(`/pipeline/${id}`);
  const [companies, contacts, stages, owners, products, defs, settings, leadSources] = await Promise.all([companyOptions(), contactOptions(opp.companyId), listStages(), listOwners(), productOptions(), listCustomFieldDefs("opportunity"), getAppSettings(), listLeadSources()]);
  return (
    <>
      <PageHeader title={`Edit ${opp.title}`} breadcrumbs={[{ label: "Sales Pipeline", href: "/pipeline" }, { label: opp.title, href: `/pipeline/${id}` }, { label: "Edit" }]} />
      <Card className="max-w-5xl">
        <OpportunityForm
          action={updateOpportunityAction.bind(null, id)}
          initial={{ ...opp, customFields: opp.customFields }}
          lines={opp.lines.map((l) => ({ key: l.id, productId: l.productId ?? "", description: l.description, revenueType: l.revenueType, pricingModel: l.pricingModel, billingFrequency: l.billingFrequency, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), unitCost: l.unitCost === null ? null : Number(l.unitCost) }))}
          companies={companies}
          contacts={contacts}
          stages={stages.filter((s) => !s.isWon && !s.isLost)}
          owners={owners}
          products={products}
          customFieldDefs={defs}
          currency={settings.currency}
          cancelHref={`/pipeline/${id}`}
          leadSources={leadSources}
        />
      </Card>
    </>
  );
}
