import type { BetterProposalsClient, BpProposal, CreateProposalInput, CreateProposalResult } from "./types";

/**
 * DEMO adapter. Returns synthetic data and simulates a proposal moving
 * sent → opened → signed over a few polls. Only used when DEMO_MODE=true and
 * no live token is configured. The UI always labels this as demo, and
 * `testConnection` never reports a connected account.
 */
const store = new Map<string, BpProposal>();
let counter = 90000;

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
    mk({ subjectLine: "Security awareness (DEMO)", companyName: "Greenfield Primary Academy", status: "signed", openedAt: new Date(Date.now() - 3 * 86400000), signedAt: new Date(Date.now() - 86400000), signedBy: "Sarah Okafor" }),
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
  async listTemplates() {
    return [
      { id: "demo-tpl-1", name: "Managed IT Agreement (demo)", description: "Standard MSA template", isDefault: true },
      { id: "demo-tpl-2", name: "Project Proposal (demo)", description: null, isDefault: false },
    ];
  }
  async listCompanies() {
    const names = new Map<string, string>();
    for (const p of store.values()) if (p.companyName) names.set(p.companyName, `demo-co-${names.size + 1}`);
    return [...names.entries()].map(([name, id]) => ({ id, name }));
  }
  async createCompany(name: string) {
    return { id: `demo-co-${Date.now()}`, name };
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
