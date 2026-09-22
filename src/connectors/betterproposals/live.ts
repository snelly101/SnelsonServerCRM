import { HttpClient, HttpError, describeError } from "@/lib/integrations/http";
import type { BetterProposalsClient, BpApiResponse, BpBrandRaw, BpCompanyRaw, BpMergeTagRaw, BpProposal, BpProposalRaw, BpSettingsRaw, BpTemplateRaw, CreateProposalInput, CreateProposalResult } from "./types";

export const BP_BASE_URL = "https://api.betterproposals.io";

/**
 * Live Better Proposals connector.
 * Auth: static API token in a `Bptoken` header (Premium/Enterprise plans).
 * All endpoints are documented at https://betterproposals.io/resources/api/.
 * POST bodies are form-encoded, as in the vendor's own examples.
 * No webhooks are documented, so state changes are discovered by polling.
 */
export class LiveBetterProposalsClient implements BetterProposalsClient {
  readonly mode = "live" as const;
  private http: HttpClient;

  constructor(apiToken: string, fetchImpl?: typeof fetch) {
    this.http = new HttpClient({
      name: "betterproposals",
      baseUrl: BP_BASE_URL,
      headers: () => ({ Bptoken: apiToken }),
      // Limits are not published; stay polite.
      minIntervalMs: 250,
      timeoutMs: 30_000,
      maxAttempts: 4,
      fetchImpl,
    });
  }

  private unwrap<T>(res: { status: number; data: BpApiResponse<T> | string | null }, what: string): T {
    const d = res.data;
    if (!d || typeof d === "string") throw new Error(`Better Proposals returned a non-JSON response for ${what}`);
    if (d.status === "error") throw new Error(`Better Proposals: ${d.message}`);
    return d.data;
  }

  async testConnection() {
    try {
      const settings = this.unwrap(await this.http.get<BpApiResponse<BpSettingsRaw>>("/settings"), "settings");
      let brand: BpBrandRaw | null = null;
      try {
        brand = this.unwrap(await this.http.get<BpApiResponse<BpBrandRaw>>("/settings/brand"), "brand");
      } catch {
        /* brand settings are optional */
      }
      return { ok: true as const, accountName: brand?.CompanyName ?? brand?.Name ?? `Account ${settings.AccountID}`, accountId: String(settings.AccountID), taxLabel: brand?.TaxLabel ?? settings.TaxLabel ?? null, taxAmount: brand?.TaxAmount ?? settings.TaxAmount ?? null };
    } catch (err) {
      return { ok: false as const, error: describeError(err) };
    }
  }

  async listProposals(filter: "all" | "new" | "sent" | "opened" | "signed" | "paid", page: number, perPage = 50): Promise<BpProposal[]> {
    const path = filter === "all" ? "/proposal" : `/proposal/${filter}`;
    const data = this.unwrap(await this.http.get<BpApiResponse<BpProposalRaw[]>>(path, { page, per_page: perPage }), path);
    return (Array.isArray(data) ? data : []).map(normaliseProposal);
  }

  async getProposal(externalId: string): Promise<BpProposal | null> {
    try {
      const data = this.unwrap(await this.http.get<BpApiResponse<BpProposalRaw>>(`/proposal/${encodeURIComponent(externalId)}`), "proposal");
      return data && data.ID ? normaliseProposal(data) : null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      if (err instanceof Error && /not found/i.test(err.message)) return null;
      throw err;
    }
  }

  async listTemplates() {
    const out: { id: string; name: string; description: string | null; isDefault: boolean }[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = this.unwrap(await this.http.get<BpApiResponse<BpTemplateRaw[]>>("/template", { page, per_page: 50 }), "templates");
      if (!Array.isArray(data) || data.length === 0) break;
      for (const t of data) if (t.Deleted !== "1") out.push({ id: String(t.ID), name: t.TemplateName, description: t.Description ?? null, isDefault: t.Default === "1" });
      if (data.length < 50) break;
    }
    return out;
  }

  async listCompanies(page: number, perPage = 50) {
    const data = this.unwrap(await this.http.get<BpApiResponse<BpCompanyRaw[]>>("/company", { page, per_page: perPage }), "companies");
    return (Array.isArray(data) ? data : []).filter((c) => c.Deleted !== "1").map((c) => ({ id: String(c.ID), name: c.CompanyName }));
  }

  async createCompany(name: string) {
    const data = this.unwrap(await this.http.postForm<BpApiResponse<BpCompanyRaw>>("/company/create", { CompanyName: name }), "company create");
    return { id: String(data.ID), name: data.CompanyName ?? name };
  }

  async listMergeTags() {
    const data = this.unwrap(await this.http.get<BpApiResponse<BpMergeTagRaw[]>>("/settings/merge_tag", { page: 1, per_page: 100 }), "merge tags");
    return (Array.isArray(data) ? data : []).filter((t) => t.Archived !== "1").map((t) => ({ tag: t.Tag, name: t.Name, fallback: t.Fallback ?? null }));
  }

  /**
   * POST /proposal/create. Documented fields only: Company, Cover, Template,
   * DocumentType, Brand, Currency, Tax, TaxLabel, TaxAmount, Contacts[], MergeTags.
   * Line-item pricing is NOT accepted by this endpoint; the proposal's quote is
   * edited in Better Proposals (the CRM shows a hand-off link).
   */
  async createProposal(input: CreateProposalInput): Promise<CreateProposalResult> {
    const form: Record<string, string> = { Company: input.company };
    if (input.templateId) form.Template = input.templateId;
    if (input.coverId) form.Cover = input.coverId;
    if (input.documentType) form.DocumentType = input.documentType;
    if (input.brandId) form.Brand = input.brandId;
    if (input.currency) form.Currency = input.currency.toLowerCase();
    if (input.tax !== undefined) form.Tax = input.tax ? "1" : "0";
    if (input.taxLabel) form.TaxLabel = input.taxLabel;
    if (input.taxAmount) form.TaxAmount = input.taxAmount;
    input.contacts.forEach((c, i) => {
      form[`Contacts[${i}][FirstName]`] = c.firstName;
      form[`Contacts[${i}][Surname]`] = c.surname;
      form[`Contacts[${i}][Email]`] = c.email;
      form[`Contacts[${i}][Signature]`] = c.signature ? "1" : "0";
    });
    if (input.mergeTags.length) form.MergeTags = JSON.stringify(input.mergeTags);
    const data = this.unwrap(await this.http.postForm<BpApiResponse<Record<string, unknown>>>("/proposal/create", form), "proposal create");
    const id = String((data as { ID?: string; id?: string; ProposalID?: string }).ID ?? (data as { id?: string }).id ?? (data as { ProposalID?: string }).ProposalID ?? "");
    if (!id) throw new Error("Better Proposals did not return a proposal ID");
    return { externalId: id, viewUrl: ((data as { ProposalView?: string }).ProposalView as string) ?? null, raw: data };
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const date = (v: unknown): Date | null => {
  if (!v || typeof v !== "string" || v.startsWith("0000")) return null;
  const d = new Date(v.replace(" ", "T") + (v.length === 19 ? "Z" : ""));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function normaliseProposal(r: BpProposalRaw): BpProposal {
  const signedAt = date(r.DateSigned ?? r.SignedDate);
  const paidAt = date(r.DatePaid);
  const openedAt = date(r.ProposalOpened);
  const sentAt = date(r.DateSent ?? r.OriginalDateSent ?? r.LastDateSent);
  const signed = r.Signed === "1" || Boolean(signedAt);
  const paid = r.Paid === "1" || Boolean(paidAt);
  const status: BpProposal["status"] = paid ? "paid" : signed ? "signed" : openedAt ? "opened" : sentAt ? "sent" : "draft";
  const signedBy = r.SignedSignature ?? r.SignedName ?? ([r.SignedFirstName, r.SignedSurname].filter(Boolean).join(" ") || null);
  return {
    externalId: String(r.ID),
    subjectLine: r.SubjectLine ?? null,
    companyName: r.CompanyName ?? null,
    companyCrmId: r.CompanyCRMID ?? null,
    opportunityCrmId: r.CRMOpportunityID ?? null,
    currencyCode: r.CurrencyCode ?? null,
    status,
    createdAt: date(r.DateCreated),
    sentAt,
    openedAt,
    signedAt,
    signedBy,
    paidAt,
    oneOffTotal: num(r.OneOffTotal),
    monthlyTotal: num(r.MonthlyTotal),
    quarterlyTotal: num(r.QuarterlyTotal),
    annualTotal: num(r.AnnualTotal),
    viewUrl: r.ProposalView ?? null,
    previewUrl: r.Preview ?? null,
    contacts: (r.Contacts ?? []).map((c) => ({ email: c.Email ?? null, firstName: c.FirstName ?? null, lastName: c.Surname ?? null })),
    raw: r,
  };
}
