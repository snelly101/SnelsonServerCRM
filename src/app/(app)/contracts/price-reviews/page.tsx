import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { listProducts } from "@/services/catalogue";
import { PageHeader, Card } from "@/components/ui/page";
import { PriceReviewForm } from "./form";

export const metadata = { title: "Price review" };

export default async function PriceReviewsPage() {
  const me = await requirePermission("contract.read");
  const [settings, products] = await Promise.all([getAppSettings(), listProducts()]);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: "Price review" }]}
        title="Price review"
        description="Propose a sell price change, or pass a supplier cost change through, and see every affected customer with current and projected margin and the agreement constraints before anything is applied. Applied changes are dated and reasoned in each contract's history; no price ever changes silently."
      />
      <Card>
        <PriceReviewForm products={products.map((p) => ({ id: p.id, name: p.name, unitPrice: p.unitPrice, unitCost: p.unitCost }))} currency={settings.currency} settings={settings} canApply={can(me.role, "contract.write")} />
      </Card>
    </>
  );
}
