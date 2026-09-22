import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { listProducts } from "@/services/catalogue";
import { PageHeader, Card, EmptyState } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ProductDialog } from "./product-dialog";
import { fmtMoney, fmtPercent } from "@/lib/format";
import { CATEGORY_LABELS, FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS } from "@/lib/validation-sales";

export const metadata = { title: "Service catalogue" };

export default async function CataloguePage() {
  const me = await requirePermission("catalogue.read");
  const [products, settings] = await Promise.all([listProducts({ includeInactive: true }), getAppSettings()]);
  const canWrite = can(me.role, "catalogue.write");
  const c = settings.currency;
  const grouped = new Map<string, typeof products>();
  for (const p of products) grouped.set(p.category, [...(grouped.get(p.category) ?? []), p]);

  return (
    <>
      <PageHeader
        title="Service catalogue"
        description="Products and services with list prices and costs. Used to build opportunities and contracts."
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: "Catalogue" }]}
        actions={canWrite && <ProductDialog />}
      />
      {products.length === 0 ? (
        <EmptyState title="Catalogue is empty" description="Add your managed IT, Microsoft 365, security, backup, networking, hardware and consultancy offerings." action={canWrite ? <ProductDialog /> : undefined} />
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([cat, rows]) => (
            <Card key={cat} title={CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat} padded={false}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>SKU</th>
                    <th>Revenue</th>
                    <th>Pricing</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Margin</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const price = Number(p.unitPrice);
                    const cost = p.unitCost === null ? null : Number(p.unitCost);
                    const margin = cost === null || price === 0 ? null : ((price - cost) / price) * 100;
                    return (
                      <tr key={p.id} className={p.active ? "" : "opacity-50"}>
                        <td>
                          <span className="font-medium">{p.name}</span>
                          {!p.active && <Badge className="ml-1">inactive</Badge>}
                          {p.countsAsManagedDevice && <Badge className="ml-1" tone="teal">device-checked</Badge>}
                          {p.description && <div className="max-w-md truncate text-xs text-slate-500">{p.description}</div>}
                        </td>
                        <td className="text-xs text-slate-500">{p.sku ?? "—"}</td>
                        <td>
                          <Badge tone={p.revenueType === "recurring" ? "green" : p.revenueType === "hardware" ? "indigo" : "blue"}>{REVENUE_LABELS[p.revenueType]}</Badge>
                        </td>
                        <td className="text-slate-600">
                          {PRICING_LABELS[p.pricingModel]}
                          {p.revenueType === "recurring" && <span className="text-xs"> · {FREQUENCY_LABELS[p.billingFrequency]}</span>}
                        </td>
                        <td className="text-right tabular-nums">{fmtMoney(price, c)}</td>
                        <td className="text-right tabular-nums text-slate-500">{cost === null ? <span title="Cost unknown">—</span> : fmtMoney(cost, c)}</td>
                        <td className="text-right tabular-nums">{margin === null ? <span className="text-xs text-slate-400">unknown</span> : fmtPercent(margin, 0)}</td>
                        <td className="text-right">{canWrite && <ProductDialog product={{ ...p, unitPrice: price, unitCost: cost }} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
