import {
  PAX8_CONSOLE,
  type Pax8Client,
  type Pax8CompanyRaw,
  type Pax8InvoiceItemRaw,
  type Pax8InvoiceRaw,
  type Pax8ProductRaw,
  type Pax8SubscriptionRaw,
} from "./types";

/**
 * DEMO adapter for Pax8: a partner account with a handful of customer
 * companies, the licences they hold and the last three partner invoices.
 * Read-only like the live client. Never reports as connected. Names and
 * quantities line up with the seed companies and contracts so the matcher
 * and the licence check have something to show: two counts differ from the
 * contract on purpose, two subscriptions have no contract line, and two
 * companies are deliberately unmatched.
 */
const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86400000).toISOString();
const dateOnly = (daysFromNow: number) => iso(daysFromNow).slice(0, 10);
const monthStart = (monthsAgo: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (monthsAgo: number) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

const companies: Pax8CompanyRaw[] = [
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000001",
    name: "Harrowgate Dental Practice",
    website: "https://www.harrowgatedental.co.uk",
    phone: "01423 500000",
    address: { city: "Harrogate", country: "GB" },
    status: "Active",
    externalId: null,
  },
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000002",
    name: "Northern Freight Solutions",
    website: "northernfreight.co.uk",
    phone: "0113 496 0137",
    address: { city: "Leeds", country: "GB" },
    status: "Active",
    externalId: "NFS-01",
  },
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000003",
    name: "Bramley & Sons Accountants",
    website: "bramleyaccountants.co.uk",
    address: { city: "Bradford", country: "GB" },
    status: "Active",
  },
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000004",
    name: "Ridgeway Architects LLP",
    website: "https://ridgewayarch.com",
    address: { city: "York", country: "GB" },
    status: "Active",
  },
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000005",
    name: "Greenfield Primary Academy",
    website: "greenfieldacademy.org.uk",
    address: { city: "Wakefield", country: "GB" },
    status: "Active",
  },
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000006",
    name: "Calder Valley Veterinary Group",
    website: null,
    address: { city: "Halifax", country: "GB" },
    status: "Active",
  },
  {
    id: "c1a7e2d0-0001-4d8e-9a10-000000000007",
    name: "Moorland Outdoor Supplies",
    website: "moorlandoutdoor.co.uk",
    address: { city: "Ilkley", country: "GB" },
    status: "Inactive",
  },
];

const products: Pax8ProductRaw[] = [
  {
    id: "p-m365-bp",
    name: "Microsoft 365 Business Premium",
    vendorName: "Microsoft",
    sku: "CFQ7TTC0LCHC:0002",
    vendorSku: "CFQ7TTC0LCHC",
    shortDescription:
      "Office apps, Exchange, Teams, Intune and Defender for Business",
  },
  {
    id: "p-m365-bs",
    name: "Microsoft 365 Business Standard",
    vendorName: "Microsoft",
    sku: "CFQ7TTC0LDPB:0001",
    vendorSku: "CFQ7TTC0LDPB",
    shortDescription: "Office apps, Exchange, Teams",
  },
  {
    id: "p-exo-p1",
    name: "Exchange Online (Plan 1)",
    vendorName: "Microsoft",
    sku: "CFQ7TTC0LH16:0001",
    vendorSku: "CFQ7TTC0LH16",
  },
  {
    id: "p-m365-a3",
    name: "Microsoft 365 A3 for faculty",
    vendorName: "Microsoft",
    sku: "CFQ7TTC0LCHT:0001",
    vendorSku: "CFQ7TTC0LCHT",
  },
  {
    id: "p-visio-p2",
    name: "Visio Plan 2",
    vendorName: "Microsoft",
    sku: "CFQ7TTC0HD33:0003",
    vendorSku: "CFQ7TTC0HD33",
  },
  {
    id: "p-acr-m365",
    name: "Acronis Cyber Protect Cloud - Microsoft 365 seat",
    vendorName: "Acronis",
    sku: "ACR-M365-SEAT",
    vendorSku: "M365SEAT",
  },
  {
    id: "p-m365-bb",
    name: "Microsoft 365 Business Basic",
    vendorName: "Microsoft",
    sku: "CFQ7TTC0LH18:0001",
    vendorSku: "CFQ7TTC0LH18",
  },
];

const sub = (
  id: string,
  companyId: string,
  productId: string,
  quantity: number,
  price: number,
  over: Partial<Pax8SubscriptionRaw> = {},
): Pax8SubscriptionRaw => ({
  id,
  companyId,
  productId,
  quantity,
  price,
  currency: "GBP",
  status: "Active",
  billingTerm: "Monthly",
  commitmentTerm: { term: "Annual", endDate: dateOnly(200) },
  startDate: dateOnly(-165),
  createdDate: iso(-165),
  billingStart: dateOnly(-165),
  endDate: null,
  ...over,
});

const C = Object.fromEntries(companies.map((c) => [c.name, c.id]));
const subscriptions: Pax8SubscriptionRaw[] = [
  // Harrowgate: Standard matches the contract (14); the Acronis seats have no line by name and need a manual link; Visio was cancelled.
  sub("s-1001", C["Harrowgate Dental Practice"], "p-m365-bs", 14, 9.4),
  sub("s-1002", C["Harrowgate Dental Practice"], "p-acr-m365", 14, 1.55, {
    billingTerm: "Monthly",
    commitmentTerm: { term: "Monthly", endDate: null },
  }),
  sub("s-1003", C["Harrowgate Dental Practice"], "p-visio-p2", 1, 11.3, {
    status: "Cancelled",
    endDate: dateOnly(-40),
  }),
  // Northern Freight: two more Premium licences than the contract bills; Exchange-only users have no line.
  sub("s-1004", C["Northern Freight Solutions"], "p-m365-bp", 34, 16.6),
  sub("s-1005", C["Northern Freight Solutions"], "p-exo-p1", 3, 3.0, {
    commitmentTerm: { term: "Monthly", endDate: null },
  }),
  // Bramley: matches.
  sub("s-1006", C["Bramley & Sons Accountants"], "p-m365-bp", 9, 16.6, {
    billingTerm: "Annual",
    price: 182.6,
    commitmentTerm: { term: "Annual", endDate: dateOnly(22) },
  }),
  // Ridgeway: two fewer than billed.
  sub("s-1007", C["Ridgeway Architects LLP"], "p-m365-bs", 16, 9.4),
  // Greenfield: education SKU with no line.
  sub("s-1008", C["Greenfield Primary Academy"], "p-m365-a3", 12, 6.9),
  // Unmatched companies.
  sub("s-1009", C["Calder Valley Veterinary Group"], "p-m365-bb", 6, 4.5),
  sub("s-1010", C["Moorland Outdoor Supplies"], "p-m365-bb", 5, 4.5, {
    status: "PendingCancel",
  }),
];

const invoices: Pax8InvoiceRaw[] = [0, 1, 2].map((m) => ({
  id: `inv-${monthStart(m)}`,
  status: m === 0 ? "Unpaid" : "Paid",
  invoiceDate: monthStart(m),
  dueDate: monthEnd(m),
  total: 0,
  currency: "GBP",
  partnerName: "Snelson Server",
}));

function itemsFor(invoice: Pax8InvoiceRaw): Pax8InvoiceItemRaw[] {
  const monthsAgo = invoices.findIndex((i) => i.id === invoice.id);
  const items: Pax8InvoiceItemRaw[] = [];
  for (const s of subscriptions) {
    if (s.status === "Cancelled" && monthsAgo < 2) continue;
    if (s.billingTerm === "Annual" && monthsAgo !== 2) continue;
    const qty = s.id === "s-1004" && monthsAgo === 2 ? 32 : (s.quantity ?? 0);
    const unit = Number(s.price);
    items.push({
      id: `${invoice.id}:${s.id}`,
      type: "Subscription",
      companyId: s.companyId,
      productId: s.productId,
      sku: products.find((p) => p.id === s.productId)?.sku ?? null,
      description:
        products.find((p) => p.id === s.productId)?.name ?? s.productId,
      quantity: qty,
      unitPrice: unit,
      total: Math.round(qty * unit * 100) / 100,
      currency: "GBP",
      term: s.billingTerm,
      startPeriod: monthStart(monthsAgo),
      endPeriod: monthEnd(monthsAgo),
      chargeType: "Recurring",
    });
  }
  return items;
}
for (const inv of invoices)
  inv.total =
    Math.round(itemsFor(inv).reduce((a, i) => a + Number(i.total), 0) * 100) /
    100;

export class DemoPax8Client implements Pax8Client {
  readonly mode = "demo" as const;
  async testConnection() {
    return {
      ok: true as const,
      companyCount: companies.length,
      partnerName: "Demo partner",
    };
  }
  async listCompanies() {
    return companies.map((c) => ({ ...c }));
  }
  async listProducts() {
    return products.map((p) => ({ ...p }));
  }
  async listSubscriptions() {
    return subscriptions.map((s) => ({ ...s }));
  }
  async listInvoices(limit: number) {
    return invoices.slice(0, limit).map((i) => ({ ...i }));
  }
  async listInvoiceItems(invoiceId: string) {
    const inv = invoices.find((i) => i.id === invoiceId);
    return inv ? itemsFor(inv) : [];
  }
  consoleUrl(kind: "company" | "subscription", id: string) {
    return kind === "company"
      ? `${PAX8_CONSOLE}/companies/${id}`
      : `${PAX8_CONSOLE}/subscriptions/${id}`;
  }
}

/** Test hooks. */
export const DEMO_PAX8_COMPANY_IDS = Object.fromEntries(
  companies.map((c) => [c.name, c.id]),
) as Record<string, string>;
