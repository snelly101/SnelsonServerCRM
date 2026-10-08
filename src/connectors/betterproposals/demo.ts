import type { BetterProposalsClient, BpProposal, CreateProposalInput, CreateProposalResult } from "./types";

/**
 * DEMO adapter. Returns synthetic data and simulates a proposal moving
 * sent → opened → signed over a few polls. Only used when DEMO_MODE=true and
 * no live token is configured. The UI always labels this as demo, and
 * `testConnection` never reports a connected account.
 */
const store = new Map<string, BpProposal>();
/** Companies created through the client (id → name); proposals' company names are listed too. */
const companyStore = new Map<string, string>();
let counter = 90000;
let companyCounter = 0;

function seedDemo() {
  if (store.size) return;
  const mk = (over: Partial<BpProposal>): BpProposal => ({
    externalId: String(++counter),
    subjectLine: "Managed IT proposal",
    companyName: "Demo Company",
    companyCrmId: null,
    opportunityCrmId: null,
    currencyCode: "GBP",
    status: "sent",
    createdAt: new Date(Date.now() - 5 * 86400000),
    sentAt: new Date(Date.now() - 4 * 86400000),
    openedAt: null,
    signedAt: null,
    signedBy: null,
    paidAt: null,
    oneOffTotal: 1500,
    monthlyTotal: 2340,
    quarterlyTotal: null,
    annualTotal: null,
    viewUrl: "https://betterproposals.io/2/proposals/view?id=demo",
    previewUrl: null,
    contacts: [{ email: "demo@example.com", firstName: "Demo", lastName: "Contact" }],
    raw: { ID: String(counter), Demo: true },
    ...over,
  });
  for (const p of [
    mk({ subjectLine: "Managed IT for 40 users (DEMO)", companyName: "Pennine Precision Engineering", status: "opened", openedAt: new Date(Date.now() - 2 * 86400000) }),
    mk({ subjectLine: "Wi-Fi refresh (DEMO)", companyName: "The Old Mill Hotel", status: "sent" }),
    mk({ subjectLine: "Security awareness (DEMO)", companyName: "Greenfield Primary Academy", status: "signed", openedAt: new Date(Date.now() - 3 * 86400000), signedAt: new Date(Date.now() - 86400000), signedBy: "Sarah Okafor", raw: { ID: String(counter + 1), Demo: true, QuoteID: "demo-quote-1" } }),
  ])
    store.set(p.externalId, p);
}

/** Test hook: move a demo proposal to a new status. */
export function demoAdvance(externalId: string, status: BpProposal["status"], signedBy = "Demo Signer") {
  const p = store.get(externalId);
  if (!p) return;
  const now = new Date();
  if (status === "opened" || status === "signed" || status === "paid") p.openedAt ??= now;
  if (status === "signed" || status === "paid") {
    p.signedAt ??= now;
    p.signedBy ??= signedBy;
  }
  if (status === "paid") p.paidAt ??= now;
  p.status = status;
}

export function demoReset() {
  store.clear();
  companyStore.clear();
  companyCounter = 0;
}

export class DemoBetterProposalsClient implements BetterProposalsClient {
  readonly mode = "demo" as const;
  constructor() {
    seedDemo();
  }
  async testConnection() {
    return { ok: false as const, error: "Demo adapter: no Better Proposals account is connected. Enter an API token to go live." };
  }
  async listProposals(filter: "all" | "new" | "sent" | "opened" | "signed" | "paid", page: number, perPage = 50) {
    const all = [...store.values()].filter((p) => (filter === "all" ? true : filter === "new" ? p.status === "draft" : p.status === filter));
    return all.slice((page - 1) * perPage, page * perPage);
  }
  async getProposal(externalId: string) {
    return store.get(externalId) ?? null;
  }
  async getProposalRaw(externalId: string) {
    const p = store.get(externalId);
    return p ? { ...p.raw, SubjectLine: p.subjectLine, MonthlyTotal: p.monthlyTotal === null ? null : p.monthlyTotal.toFixed(2), OneOffTotal: p.oneOffTotal === null ? null : p.oneOffTotal.toFixed(2) } : null;
  }
  /** A quote in the shape the live API is believed to use: sections of priced rows with a billing type. Only the signed demo proposal has one. */
  async getQuote(quoteId: string) {
    if (quoteId !== "demo-quote-1") return null;
    return {
      ID: quoteId,
      Title: "Security awareness (DEMO)",
      Currency: "GBP",
      Sections: [
        { Title: "Monthly services", Type: "Monthly", Items: [
          { Name: "Security awareness training", Description: "Per user, monthly", Quantity: "60", Price: "2.50", Total: "150.00" },
          { Name: "Managed phishing simulation", Description: "Per user, monthly", Quantity: "60", Price: "1.50", Total: "90.00" },
          { Name: "Managed firewall", Quantity: "1", Price: "2100.00", Total: "2100.00" },
        ] },
        { Title: "One-off", Type: "OneOff", Items: [
          { Name: "Onboarding and baseline assessment", Quantity: "1", Price: "1500.00", Total: "1500.00" },
        ] },
      ],
    };
  }
  async listTemplates() {
    return [
      { id: "demo-tpl-1", name: "Managed IT Agreement (demo)", description: "Standard MSA template", isDefault: true },
      { id: "demo-tpl-2", name: "Project Proposal (demo)", description: null, isDefault: false },
    ];
  }
  async listCompanies(page = 1, perPage = 50) {
    const names = new Map<string, string>();
    for (const p of store.values()) if (p.companyName && ![...companyStore.values()].includes(p.companyName)) names.set(p.companyName, `demo-co-${names.size + 1}`);
    const all = [...[...companyStore.entries()].map(([id, name]) => ({ id, name })), ...[...names.entries()].map(([name, id]) => ({ id, name }))];
    return all.slice((page - 1) * perPage, page * perPage);
  }
  async createCompany(name: string) {
    const id = `demo-co-${++companyCounter}`;
    companyStore.set(id, name);
    return { id, name };
  }
  async listMergeTags() {
    return [
      { tag: "contract_term", name: "Contract term", fallback: "12 months" },
      { tag: "account_manager", name: "Account manager", fallback: null },
    ];
  }
  async createProposal(input: CreateProposalInput): Promise<CreateProposalResult> {
    const id = String(++counter);
    const p: BpProposal = {
      externalId: id,
      subjectLine: `Proposal from template ${input.templateId ?? "default"} (DEMO)`,
      companyName: input.company,
      companyCrmId: null,
      opportunityCrmId: null,
      currencyCode: input.currency?.toUpperCase() ?? "GBP",
      status: "draft",
      createdAt: new Date(),
      sentAt: null,
      openedAt: null,
      signedAt: null,
      signedBy: null,
      paidAt: null,
      oneOffTotal: null,
      monthlyTotal: null,
      quarterlyTotal: null,
      annualTotal: null,
      viewUrl: `https://betterproposals.io/2/proposals/view?id=${id}`,
      previewUrl: null,
      contacts: input.contacts.map((c) => ({ email: c.email, firstName: c.firstName, lastName: c.surname })),
      raw: { ID: id, Demo: true, MergeTags: input.mergeTags },
    };
    store.set(id, p);
    return { externalId: id, viewUrl: p.viewUrl, raw: p.raw };
  }
}
