import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { listLeadSources, listStages } from "@/services/opportunities";
import { listOwners } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { companyOptions, contactOptions, productOptions } from "@/services/lookups";
import { createOpportunityAction } from "@/actions/sales";
import { PageHeader, Card } from "@/components/ui/page";
import { OpportunityForm } from "@/components/opportunity-form";

export const metadata = { title: "New opportunity" };

export default async function NewOpportunityPage({ searchParams }: { searchParams: Promise<{ companyId?: string }> }) {
  await requirePermission("opportunity.write");
  const { companyId } = await searchParams;
  const [companies, contacts, stages, owners, products, defs, settings, leadSources] = await Promise.all([companyOptions(), contactOptions(), listStages(), listOwners(), productOptions(), listCustomFieldDefs("opportunity"), getAppSettings(), listLeadSources()]);
  return (
    <>
      <PageHeader title="New opportunity" breadcrumbs={[{ label: "Sales Pipeline", href: "/pipeline" }, { label: "New" }]} />
      <Card className="max-w-5xl">
        <OpportunityForm
          action={createOpportunityAction}
          initial={{ companyId }}
          lines={[]}
          companies={companies}
          contacts={contacts}
          stages={stages.filter((s) => !s.isWon && !s.isLost)}
          owners={owners}
          products={products}
          customFieldDefs={defs}
          currency={settings.currency}
          cancelHref={companyId ? `/companies/${companyId}` : "/pipeline"}
          leadSources={leadSources}
        />
      </Card>
    </>
  );
}
