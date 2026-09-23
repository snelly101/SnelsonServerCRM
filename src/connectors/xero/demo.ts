import type { CreateInvoiceInput, XeroClient, XeroContactRaw, XeroInvoiceRaw, XeroPaymentRaw, XeroRepeatingInvoiceRaw, XeroItemRaw } from "./types";

/**
 * DEMO adapter for Xero: an in-memory organisation with a few customers,
 * invoices and payments. Never reports as connected. `createDraftInvoice`
 * records a DRAFT in memory so the CRM flow can be exercised end to end.
 */
const now = Date.now();
const day = (n: number) => new Date(now + n * 86400000).toISOString().slice(0, 10);
const iso = (n: number) => new Date(now + n * 86400000).toISOString();

const contacts = new Map<string, XeroContactRaw>();
const invoices = new Map<string, XeroInvoiceRaw>();
const payments = new Map<string, XeroPaymentRaw>();
let seq = 1000;

function seed() {
  if (contacts.size) return;
  const mk = (id: string, name: string, email: string, extra: Partial<XeroContactRaw> = {}) => contacts.set(id, { ContactID: id, ContactStatus: "ACTIVE", Name: name, EmailAddress: email, IsCustomer: true, IsSupplier: false, UpdatedDateUTC: iso(-10), Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "0113 496 0000" }], Addresses: [{ AddressType: "POBOX", AddressLine1: "1 High Street", City: "Leeds", PostalCode: "LS1 1AA", Country: "GB" }], Balances: { AccountsReceivable: { Outstanding: 0, Overdue: 0 } }, ...extra });
  mk("demo-c-1", "Harrowgate Dental Practice", "accounts@harrowgatedental.co.uk", { CompanyNumber: "08123456", Balances: { AccountsReceivable: { Outstanding: 1238.64, Overdue: 0 } } });
  mk("demo-c-2", "Northern Freight Solutions Ltd", "finance@northernfreight.co.uk", { TaxNumber: "GB123456789", Balances: { AccountsReceivable: { Outstanding: 7222.08, Overdue: 3611.04 } } });
  mk("demo-c-3", "Ridgeway Architects", "chloe.wang@ridgewayarch.com", { Balances: { AccountsReceivable: { Outstanding: 0, Overdue: 0 } } });
  mk("demo-c-4", "Greenfield Primary Academy", "finance@greenfieldacademy.org.uk");
  mk("demo-c-5", "Bramley Accountants Ltd", "helen.bramley@bramleyaccountants.co.uk");
  mk("demo-c-6", "Old Supplier Ltd", "ap@oldsupplier.example", { IsCustomer: false, IsSupplier: true });
  const inv = (id: string, contact: string, number: string, status: XeroInvoiceRaw["Status"], total: number, dateOffset: number, due: number, paid = 0) =>
    invoices.set(id, { InvoiceID: id, Type: "ACCREC", InvoiceNumber: number, Reference: "", Status: status, Contact: { ContactID: contact, Name: contacts.get(contact)!.Name }, DateString: day(dateOffset), DueDateString: day(due), CurrencyCode: "GBP", LineAmountTypes: "Exclusive", SubTotal: total / 1.2, TotalTax: total - total / 1.2, Total: total, AmountPaid: paid, AmountDue: status === "PAID" ? 0 : total - paid, AmountCredited: 0, FullyPaidOnDate: status === "PAID" ? day(due - 3) : undefined, SentToContact: status !== "DRAFT", UpdatedDateUTC: iso(dateOffset), LineItems: [{ Description: "Managed IT services", Quantity: 1, UnitAmount: total / 1.2, AccountCode: "200", TaxType: "OUTPUT2", LineAmount: total / 1.2 }] });
  inv("demo-i-1", "demo-c-1", "INV-0101", "AUTHORISED", 1238.64, -12, 18);
  inv("demo-i-2", "demo-c-1", "INV-0087", "PAID", 1238.64, -42, -12, 1238.64);
  inv("demo-i-3", "demo-c-2", "INV-0102", "AUTHORISED", 3611.04, -35, -5);
  inv("demo-i-4", "demo-c-2", "INV-0110", "AUTHORISED", 3611.04, -5, 25);
  inv("demo-i-5", "demo-c-2", "INV-0076", "PAID", 3611.04, -65, -35, 3611.04);
  inv("demo-i-6", "demo-c-3", "INV-0099", "PAID", 1684.08, -20, 10, 1684.08);
  inv("demo-i-7", "demo-c-4", "INV-0111", "DRAFT", 4722, -1, 29);
  payments.set("demo-p-1", { PaymentID: "demo-p-1", Invoice: { InvoiceID: "demo-i-2", InvoiceNumber: "INV-0087" }, Date: day(-15), Amount: 1238.64, Status: "AUTHORISED", PaymentType: "ACCRECPAYMENT", IsReconciled: true, UpdatedDateUTC: iso(-15) });
  payments.set("demo-p-2", { PaymentID: "demo-p-2", Invoice: { InvoiceID: "demo-i-5", InvoiceNumber: "INV-0076" }, Date: day(-38), Amount: 3611.04, Status: "AUTHORISED", PaymentType: "ACCRECPAYMENT", IsReconciled: true, UpdatedDateUTC: iso(-38) });
  payments.set("demo-p-3", { PaymentID: "demo-p-3", Invoice: { InvoiceID: "demo-i-6", InvoiceNumber: "INV-0099" }, Date: day(-2), Amount: 1684.08, Status: "AUTHORISED", PaymentType: "ACCRECPAYMENT", IsReconciled: false, UpdatedDateUTC: iso(-2) });
}

/** Test hooks */
export function demoXeroReset() {
  contacts.clear();
  invoices.clear();
  payments.clear();
  seed();
}
export function demoXeroPay(invoiceId: string, amount?: number) {
  const inv = invoices.get(invoiceId);
  if (!inv) return;
  const amt = amount ?? inv.AmountDue ?? 0;
  inv.AmountPaid = (inv.AmountPaid ?? 0) + amt;
  inv.AmountDue = Math.max(0, (inv.Total ?? 0) - inv.AmountPaid);
  if (inv.AmountDue === 0) {
    inv.Status = "PAID";
    inv.FullyPaidOnDate = day(0);
  }
  inv.UpdatedDateUTC = new Date().toISOString();
  const id = `demo-p-${++seq}`;
  payments.set(id, { PaymentID: id, Invoice: { InvoiceID: invoiceId, InvoiceNumber: inv.InvoiceNumber }, Date: day(0), Amount: amt, Status: "AUTHORISED", PaymentType: "ACCRECPAYMENT", IsReconciled: false, UpdatedDateUTC: new Date().toISOString() });
}
export function demoXeroAuthorise(invoiceId: string) {
  const inv = invoices.get(invoiceId);
  if (inv && inv.Status === "DRAFT") {
    inv.Status = "AUTHORISED";
    inv.SentToContact = true;
    inv.UpdatedDateUTC = new Date().toISOString();
  }
}
export function demoXeroTouchContact(contactId: string, patch: Partial<XeroContactRaw>) {
  const c = contacts.get(contactId);
  if (c) Object.assign(c, patch, { UpdatedDateUTC: new Date().toISOString() });
}

const modifiedSince = <T extends { UpdatedDateUTC?: string }>(rows: T[], since?: Date) => (since ? rows.filter((r) => !r.UpdatedDateUTC || new Date(r.UpdatedDateUTC) >= since) : rows);
const paginate = <T>(rows: T[], page: number, size = 100) => rows.slice((page - 1) * size, page * size);

const items: XeroItemRaw[] = [
  { ItemID: "demo-item-1", Code: "MIT-USER", Name: "Managed user support", Description: "Unlimited remote support per user", IsSold: true, IsPurchased: false, SalesDetails: { UnitPrice: 45, AccountCode: "201", TaxType: "OUTPUT2" } },
  { ItemID: "demo-item-2", Code: "MIT-DEV", Name: "Managed device (RMM + patching)", IsSold: true, IsPurchased: true, SalesDetails: { UnitPrice: 12, AccountCode: "201", TaxType: "OUTPUT2" }, PurchaseDetails: { UnitPrice: 4.5, AccountCode: "300" } },
  { ItemID: "demo-item-3", Code: "EDR-SEAT", Name: "Endpoint protection seat", IsSold: true, IsPurchased: true, SalesDetails: { UnitPrice: 15, AccountCode: "201", TaxType: "OUTPUT2" }, PurchaseDetails: { UnitPrice: 6.5, AccountCode: "300" } },
];

/** Repeating invoice templates: a monthly one with catalogue item codes, a quarterly one, a weekly one (unsupported), a draft, and a supplier bill. */
const repeating: XeroRepeatingInvoiceRaw[] = [
  { RepeatingInvoiceID: "demo-ri-1", Type: "ACCREC", Status: "AUTHORISED", Contact: { ContactID: "demo-c-2", Name: "Northern Freight Solutions Ltd" }, Schedule: { Period: 1, Unit: "MONTHLY", DueDate: 30, DueDateType: "DAYSAFTERBILLDATE", StartDate: "/Date(1767225600000+0000)/", NextScheduledDate: "/Date(1790812800000+0000)/" }, LineAmountTypes: "Exclusive", Reference: "Managed IT & Security", CurrencyCode: "GBP", LineItems: [
    { Description: "Managed user support", Quantity: 32, UnitAmount: 45, ItemCode: "MIT-USER", AccountCode: "201", TaxType: "OUTPUT2", LineAmount: 1440 },
    { Description: "Managed device (RMM + patching)", Quantity: 40, UnitAmount: 12, ItemCode: "MIT-DEV", AccountCode: "201", TaxType: "OUTPUT2", LineAmount: 480 },
    { Description: "Firewall monitoring", Quantity: 2, UnitAmount: 35, AccountCode: "201", TaxType: "OUTPUT2", LineAmount: 70 },
  ], SubTotal: 1990, TotalTax: 398, Total: 2388 },
  { RepeatingInvoiceID: "demo-ri-2", Type: "ACCREC", Status: "AUTHORISED", Contact: { ContactID: "demo-c-1", Name: "Harrowgate Dental Practice" }, Schedule: { Period: 3, Unit: "MONTHLY", DueDate: 14, DueDateType: "DAYSAFTERBILLDATE", StartDate: "/Date(1775001600000+0000)/", NextScheduledDate: "/Date(1790812800000+0000)/", EndDate: "/Date(1806451200000+0000)/" }, LineAmountTypes: "Inclusive", Reference: "Quarterly support", CurrencyCode: "GBP", LineItems: [
    { Description: "Endpoint protection (18 devices)", Quantity: 18, UnitAmount: 18, ItemCode: "EDR-SEAT", TaxType: "OUTPUT2", TaxAmount: 54, LineAmount: 324 },
  ], SubTotal: 270, TotalTax: 54, Total: 324 },
  { RepeatingInvoiceID: "demo-ri-3", Type: "ACCREC", Status: "AUTHORISED", Contact: { ContactID: "demo-c-3", Name: "Ridgeway Architects" }, Schedule: { Period: 1, Unit: "WEEKLY", StartDate: "/Date(1767225600000+0000)/" }, LineAmountTypes: "Exclusive", Reference: "Weekly on-site", CurrencyCode: "GBP", LineItems: [{ Description: "On-site day", Quantity: 1, UnitAmount: 450, LineAmount: 450 }], SubTotal: 450, TotalTax: 90, Total: 540 },
  { RepeatingInvoiceID: "demo-ri-4", Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: "demo-c-4", Name: "Greenfield Primary Academy" }, Schedule: { Period: 1, Unit: "MONTHLY", StartDate: "/Date(1767225600000+0000)/" }, LineAmountTypes: "Exclusive", Reference: "Draft template", LineItems: [{ Description: "Draft", Quantity: 1, UnitAmount: 1, LineAmount: 1 }], SubTotal: 1, TotalTax: 0, Total: 1 },
  { RepeatingInvoiceID: "demo-ri-5", Type: "ACCPAY", Status: "AUTHORISED", Contact: { ContactID: "demo-c-6", Name: "Old Supplier Ltd" }, Schedule: { Period: 1, Unit: "MONTHLY" }, LineItems: [{ Description: "Hosting", Quantity: 1, UnitAmount: 99, LineAmount: 99 }], SubTotal: 99, TotalTax: 0, Total: 99 },
];

export class DemoXeroClient implements XeroClient {
  readonly mode = "demo" as const;
  constructor() {
    seed();
  }
  async testConnection() {
    return { ok: false as const, error: "Demo adapter: no Xero organisation is connected. Use Connect to Xero to go live." };
  }
  async getOrganisation() {
    return { OrganisationID: "demo-org", Name: "Demo Organisation (not connected)", BaseCurrency: "GBP", CountryCode: "GB" };
  }
  async listContacts(opts: { page: number; ifModifiedSince?: Date; includeArchived?: boolean }) {
    return paginate(modifiedSince([...contacts.values()].filter((c) => opts.includeArchived || c.ContactStatus === "ACTIVE"), opts.ifModifiedSince), opts.page);
  }
  async getContact(id: string) {
    return contacts.get(id) ?? null;
  }
  async createContact(input: { name: string; emailAddress?: string | null; taxNumber?: string | null; companyNumber?: string | null; phone?: string | null }) {
    const id = `demo-c-${++seq}`;
    const c: XeroContactRaw = { ContactID: id, ContactStatus: "ACTIVE", Name: input.name, EmailAddress: input.emailAddress ?? undefined, TaxNumber: input.taxNumber ?? undefined, CompanyNumber: input.companyNumber ?? undefined, IsCustomer: true, Phones: input.phone ? [{ PhoneType: "DEFAULT", PhoneNumber: input.phone }] : [], UpdatedDateUTC: new Date().toISOString(), Balances: { AccountsReceivable: { Outstanding: 0, Overdue: 0 } } };
    contacts.set(id, c);
    return c;
  }
  async updateContact(contactId: string, patch: { emailAddress?: string | null; phone?: string | null }) {
    const c = contacts.get(contactId);
    if (!c) throw new Error("Contact not found");
    if (patch.emailAddress !== undefined) c.EmailAddress = patch.emailAddress ?? undefined;
    if (patch.phone) c.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: patch.phone }];
    c.UpdatedDateUTC = new Date().toISOString();
    return c;
  }
  async listInvoices(opts: { page: number; ifModifiedSince?: Date; statuses?: string[]; contactIds?: string[]; where?: string }) {
    let rows = [...invoices.values()];
    if (opts.statuses?.length) rows = rows.filter((i) => opts.statuses!.includes(i.Status));
    if (opts.contactIds?.length) rows = rows.filter((i) => opts.contactIds!.includes(i.Contact?.ContactID ?? ""));
    if (opts.where) {
      const m = /Reference=="([^"]+)"/.exec(opts.where);
      if (m) rows = rows.filter((i) => i.Reference === m[1]);
    }
    return paginate(modifiedSince(rows, opts.ifModifiedSince), opts.page);
  }
  async getInvoice(id: string) {
    return invoices.get(id) ?? null;
  }
  async createDraftInvoice(input: CreateInvoiceInput) {
    const id = `demo-i-${++seq}`;
    const sub = input.lineItems.reduce((a, l) => a + l.quantity * l.unitAmount, 0);
    const tax = input.lineAmountTypes === "NoTax" ? 0 : sub * 0.2;
    const inv: XeroInvoiceRaw = { InvoiceID: id, Type: "ACCREC", InvoiceNumber: `INV-${seq}`, Reference: input.reference, Status: "DRAFT", Contact: { ContactID: input.contactId, Name: contacts.get(input.contactId)?.Name }, DateString: input.date, DueDateString: input.dueDate, CurrencyCode: input.currencyCode, LineAmountTypes: input.lineAmountTypes, SubTotal: sub, TotalTax: tax, Total: sub + tax, AmountDue: sub + tax, AmountPaid: 0, AmountCredited: 0, SentToContact: false, UpdatedDateUTC: new Date().toISOString(), LineItems: input.lineItems.map((l) => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unitAmount, AccountCode: l.accountCode, TaxType: l.taxType, LineAmount: l.quantity * l.unitAmount })) };
    invoices.set(id, inv);
    return inv;
  }
  async getOnlineInvoiceUrl() {
    return null;
  }
  async listPayments(opts: { page: number; ifModifiedSince?: Date }) {
    return paginate(modifiedSince([...payments.values()], opts.ifModifiedSince), opts.page);
  }
  async listRepeatingInvoices() {
    return repeating;
  }
  async listItems() {
    return items;
  }
  async listAccounts() {
    return [
      { AccountID: "a-200", Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT2", Class: "REVENUE" },
      { AccountID: "a-201", Code: "201", Name: "Managed services revenue", Type: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT2", Class: "REVENUE" },
      { AccountID: "a-202", Code: "202", Name: "Hardware sales", Type: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT2", Class: "REVENUE" },
    ];
  }
  async listTaxRates() {
    return [
      { Name: "20% (VAT on Income)", TaxType: "OUTPUT2", Status: "ACTIVE", EffectiveRate: 20, CanApplyToRevenue: true },
      { Name: "Zero Rated Income", TaxType: "ZERORATEDOUTPUT", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
      { Name: "No VAT", TaxType: "NONE", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
    ];
  }
  async listBrandingThemes() {
    return [{ BrandingThemeID: "demo-theme", Name: "Standard" }];
  }
}
