/**
 * Xero Accounting API shapes (subset), from the official OpenAPI spec
 * XeroAPI/Xero-OpenAPI xero_accounting.yaml.
 */
export type XeroTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms */
  expiresAt: number;
  idToken?: string;
  scope?: string;
};

export type XeroTenant = { tenantId: string; tenantName: string; tenantType: string; id: string };

export type XeroPhone = { PhoneType: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string };
export type XeroAddress = { AddressType: string; AddressLine1?: string; AddressLine2?: string; City?: string; Region?: string; PostalCode?: string; Country?: string; AttentionTo?: string };

export type XeroContactRaw = {
  ContactID: string;
  ContactStatus?: string;
  Name: string;
  FirstName?: string;
  LastName?: string;
  CompanyNumber?: string;
  EmailAddress?: string;
  TaxNumber?: string;
  AccountNumber?: string;
  IsSupplier?: boolean;
  IsCustomer?: boolean;
  Phones?: XeroPhone[];
  Addresses?: XeroAddress[];
  Balances?: { AccountsReceivable?: { Outstanding?: number; Overdue?: number }; AccountsPayable?: { Outstanding?: number; Overdue?: number } };
  UpdatedDateUTC?: string;
  [k: string]: unknown;
};

export type XeroLineItemRaw = { LineItemID?: string; Description?: string; Quantity?: number; UnitAmount?: number; ItemCode?: string; AccountCode?: string; TaxType?: string; TaxAmount?: number; LineAmount?: number };

export type XeroInvoiceRaw = {
  InvoiceID: string;
  Type: string;
  InvoiceNumber?: string;
  Reference?: string;
  Status: "DRAFT" | "SUBMITTED" | "AUTHORISED" | "PAID" | "VOIDED" | "DELETED";
  Contact?: { ContactID: string; Name?: string };
  Date?: string;
  DueDate?: string;
  DateString?: string;
  DueDateString?: string;
  CurrencyCode?: string;
  LineAmountTypes?: string;
  LineItems?: XeroLineItemRaw[];
  SubTotal?: number;
  TotalTax?: number;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  AmountCredited?: number;
  FullyPaidOnDate?: string;
  SentToContact?: boolean;
  UpdatedDateUTC?: string;
  Payments?: XeroPaymentRaw[];
  [k: string]: unknown;
};

export type XeroPaymentRaw = {
  PaymentID: string;
  Invoice?: { InvoiceID: string; InvoiceNumber?: string };
  Date?: string;
  Amount?: number;
  Reference?: string;
  Status?: string;
  PaymentType?: string;
  IsReconciled?: boolean;
  UpdatedDateUTC?: string;
  [k: string]: unknown;
};

export type XeroAccount = { AccountID: string; Code?: string; Name: string; Type: string; Status?: string; TaxType?: string; Class?: string };
export type XeroTaxRate = { Name: string; TaxType: string; Status?: string; EffectiveRate?: number; CanApplyToRevenue?: boolean };
export type XeroOrganisation = { OrganisationID: string; Name: string; LegalName?: string; BaseCurrency?: string; CountryCode?: string; ShortCode?: string; OrganisationStatus?: string };
export type XeroBrandingTheme = { BrandingThemeID: string; Name: string };

export type CreateInvoiceInput = {
  contactId: string;
  reference: string;
  date: string;
  dueDate: string;
  currencyCode: string;
  lineAmountTypes: "Exclusive" | "Inclusive" | "NoTax";
  brandingThemeId?: string;
  lineItems: { description: string; quantity: number; unitAmount: number; accountCode: string; taxType: string; itemCode?: string | null }[];
  /** URL shown in Xero as "Go to <app>" */
  url?: string;
};

export interface XeroClient {
  readonly mode: "live" | "demo";
  testConnection(): Promise<{ ok: true; organisationName: string; organisationId: string; baseCurrency: string | null; tenantId: string } | { ok: false; error: string }>;
  getOrganisation(): Promise<XeroOrganisation>;
  listContacts(opts: { page: number; ifModifiedSince?: Date; includeArchived?: boolean; searchTerm?: string }): Promise<XeroContactRaw[]>;
  getContact(contactId: string): Promise<XeroContactRaw | null>;
  createContact(input: { name: string; emailAddress?: string | null; firstName?: string | null; lastName?: string | null; taxNumber?: string | null; companyNumber?: string | null; phone?: string | null; address?: XeroAddress | null }, idempotencyKey: string): Promise<XeroContactRaw>;
  updateContact(contactId: string, patch: { emailAddress?: string | null; phone?: string | null }, idempotencyKey: string): Promise<XeroContactRaw>;
  listInvoices(opts: { page: number; ifModifiedSince?: Date; statuses?: string[]; contactIds?: string[]; where?: string }): Promise<XeroInvoiceRaw[]>;
  getInvoice(invoiceId: string): Promise<XeroInvoiceRaw | null>;
  createDraftInvoice(input: CreateInvoiceInput, idempotencyKey: string): Promise<XeroInvoiceRaw>;
  getOnlineInvoiceUrl(invoiceId: string): Promise<string | null>;
  listPayments(opts: { page: number; ifModifiedSince?: Date }): Promise<XeroPaymentRaw[]>;
  listAccounts(): Promise<XeroAccount[]>;
  listTaxRates(): Promise<XeroTaxRate[]>;
  listBrandingThemes(): Promise<XeroBrandingTheme[]>;
}
