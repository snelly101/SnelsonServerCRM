/**
 * Better Proposals API shapes, taken from the official documentation
 * (https://betterproposals.io/resources/api/) and its example responses.
 * Values arrive as strings ("0"/"1", "0.00") — the client normalises them.
 */
export type BpApiResponse<T> = { status: "success"; data: T; count?: number } | { status: "error"; message: string };

export type BpProposalRaw = {
  ID: string;
  SubjectLine?: string | null;
  Description?: string | null;
  CompanyName?: string | null;
  CompanyCRMID?: string | null;
  CRMOpportunityID?: string | null;
  CurrencyCode?: string | null;
  TypeID?: string | null;
  BrandID?: string | null;
  CoverID?: string | null;
  QuoteID?: string | null;
  DateCreated?: string | null;
  OriginalDateSent?: string | null;
  DateSent?: string | null;
  LastDateSent?: string | null;
  ProposalOpened?: string | null;
  Signed?: string | null;
  DateSigned?: string | null;
  SignedDate?: string | null;
  SignedName?: string | null;
  SignedSignature?: string | null;
  SignedFirstName?: string | null;
  SignedSurname?: string | null;
  SignedEmail?: string | null;
  Paid?: string | null;
  DatePaid?: string | null;
  PaidAmount?: string | null;
  OneOffTotal?: string | null;
  MonthlyTotal?: string | null;
  QuarterlyTotal?: string | null;
  AnnualTotal?: string | null;
  Amount?: string | null;
  Preview?: string | null;
  ProposalView?: string | null;
  Contacts?: { Email?: string; FirstName?: string; Surname?: string; Link?: string }[];
  [k: string]: unknown;
};

export type BpTemplateRaw = { ID: string; TemplateName: string; Description?: string | null; Default?: string; Deleted?: string; [k: string]: unknown };
export type BpCompanyRaw = { ID: string; CompanyName: string; Deleted?: string; [k: string]: unknown };
export type BpMergeTagRaw = { ID: string; Name: string; Tag: string; Fallback?: string | null; Archived?: string; [k: string]: unknown };
export type BpSettingsRaw = { ID: string; AccountID: string; CurrencyID?: string; Tax?: string; TaxLabel?: string; TaxAmount?: string; TimeZone?: string; [k: string]: unknown };
export type BpBrandRaw = { ID: string; Name?: string; CompanyName?: string; Default?: string; CurrencyID?: string; Tax?: string; TaxLabel?: string; TaxAmount?: string; [k: string]: unknown };

/** Normalised proposal used by the CRM. */
export type BpProposal = {
  externalId: string;
  subjectLine: string | null;
  companyName: string | null;
  companyCrmId: string | null;
  opportunityCrmId: string | null;
  currencyCode: string | null;
  status: "draft" | "sent" | "opened" | "signed" | "paid" | "unknown";
  createdAt: Date | null;
  sentAt: Date | null;
  openedAt: Date | null;
  signedAt: Date | null;
  signedBy: string | null;
  paidAt: Date | null;
  oneOffTotal: number | null;
  monthlyTotal: number | null;
  quarterlyTotal: number | null;
  annualTotal: number | null;
  viewUrl: string | null;
  previewUrl: string | null;
  contacts: { email: string | null; firstName: string | null; lastName: string | null }[];
  raw: BpProposalRaw;
};

export type CreateProposalInput = {
  /** Better Proposals company id, or a name (which creates a new company there). */
  company: string;
  templateId?: string;
  coverId?: string;
  documentType?: string;
  brandId?: string;
  currency?: string;
  tax?: boolean;
  taxLabel?: string;
  taxAmount?: string;
  contacts: { firstName: string; surname: string; email: string; signature: boolean }[];
  mergeTags: { tag: string; value: string }[];
};

export type CreateProposalResult = { externalId: string; viewUrl: string | null; raw: Record<string, unknown> };

export interface BetterProposalsClient {
  readonly mode: "live" | "demo";
  /** Verifies the token and returns account identity. */
  testConnection(): Promise<{ ok: true; accountName: string; accountId: string; taxLabel: string | null; taxAmount: string | null } | { ok: false; error: string }>;
  listProposals(filter: "all" | "new" | "sent" | "opened" | "signed" | "paid", page: number, perPage?: number): Promise<BpProposal[]>;
  getProposal(externalId: string): Promise<BpProposal | null>;
  listTemplates(): Promise<{ id: string; name: string; description: string | null; isDefault: boolean }[]>;
  listCompanies(page: number, perPage?: number): Promise<{ id: string; name: string }[]>;
  createCompany(name: string): Promise<{ id: string; name: string }>;
  listMergeTags(): Promise<{ tag: string; name: string; fallback: string | null }[]>;
  createProposal(input: CreateProposalInput): Promise<CreateProposalResult>;
}
