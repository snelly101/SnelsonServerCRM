import type { ServiceSource, LinkRole, MatchSource } from "@/db/schema/service-links";
export type { ServiceSource, LinkRole, MatchSource };

/**
 * The shared billing model every integration is read through.
 *
 * A connector's billing adapter turns what the provider reports into
 * `SuppliedService` rows: what was supplied, to which customer, how many, what
 * it costs us per month where the supplier prices it, and when it was last
 * synced. Everything above the adapters (the service register, the quantity
 * checks, the company and contract screens, the attention queue) works on
 * this shape and on `service_links`, never on a provider's own tables, so a
 * new integration is one adapter plus a registry entry.
 */
export type ProviderKey = "pax8" | "twentyi" | "ninjaone";

export const PROVIDER_LABELS: Record<ProviderKey, string> = { pax8: "Pax8", twentyi: "20i", ninjaone: "NinjaOne" };

export type SuppliedService = {
  /** `${source}:${rowId}`; stable across syncs. */
  key: string;
  source: ServiceSource;
  /** The mirror row id (or, for a pooled service, the company id). */
  rowId: string;
  provider: ProviderKey;
  companyId: string;
  /** Short kind label: "Microsoft 365 licence", "Hosting package", "Domain", "Managed devices". */
  kind: string;
  name: string;
  /** The supplier's own product reference (SKU, package type, node class), for matching and for people checking the source. */
  supplierProduct: string | null;
  /** Every supplier code a catalogue SKU may equal (SKU, vendor SKU); defaults to the supplier product. */
  matchKeys?: string[];
  detail: string | null;
  quantity: number;
  /** Partner cost per month for the whole service (quantity included), where the supplier reports pricing. */
  monthlyCost: number | null;
  /** False when the provider carries no pricing at all (NinjaOne, 20i), so a null cost means "unknown", not "free". */
  costKnown: boolean;
  /** Supplier commitment end, domain expiry, or null. */
  renewsOn: string | null;
  status: string | null;
  syncedAt: Date | null;
  /** Where the source record is shown in the CRM. */
  href: string;
  consoleUrl: string | null;
  /** A pooled service stands for a set of members (devices) counted together; members with their own link are listed separately. */
  pool: boolean;
  members?: { id: string; name: string; detail: string | null }[];
};

export type MatchableLine = {
  id: string;
  contractId: string;
  contractName: string;
  contractStatus: string;
  description: string;
  quantity: string;
  unitPrice: string;
  unitCost: string | null;
  billingFrequency: string;
  pricingModel: string;
  quantityRule: string;
  countsAsManagedDevice: boolean;
  siteId: string | null;
  productSku: string | null;
  productName: string | null;
};

export type AutoMatch = { lineId: string; by: MatchSource } | null;

export interface BillingAdapter {
  provider: ProviderKey;
  /** Every active service the provider supplies to the given customers (all customers when null). */
  services(companyIds: string[] | null): Promise<SuppliedService[]>;
  /** Rule-based line for a service nobody has linked by hand (catalogue SKU, product name, the per-device rule). */
  autoMatch(service: SuppliedService, lines: MatchableLine[]): AutoMatch;
}

/** States a supplied service can be in: the six recorded roles plus "unmapped" (no link and no rule matches). */
export type ServiceState = LinkRole | "unmapped";

export const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  charged: "Charged on a line",
  bundle: "Included in a bundle",
  commitment: "Covered by commitment",
  free: "Intentionally free",
  internal: "Internal / non-billable",
  investigate: "Needs investigation",
  unmapped: "Unmapped",
};

export const MATCH_SOURCE_LABELS: Record<MatchSource | "rule", string> = { manual: "chosen by a person", sku: "matched by catalogue SKU", name: "matched by product name", rule: "per-device rule" };

/** Roles under which a service is not expected to produce a charge or count of its own. */
export const NON_BILLABLE_ROLES: LinkRole[] = ["free", "internal"];
/** Roles whose quantity counts toward a contract line's observed total. */
export const COUNTING_ROLES: LinkRole[] = ["charged", "bundle"];

export const QUANTITY_RULE_LABELS: Record<string, string> = { fixed: "Fixed: the agreed quantity bills", synced: "Synced: the integrations' count should bill" };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Shared SKU / name matcher used by adapters whose services carry a supplier product code and a product name. */
export function matchBySkuOrName(skus: (string | null | undefined)[], productName: string | null | undefined, lines: MatchableLine[]): AutoMatch {
  const set = new Set(skus.map(norm).filter(Boolean));
  const bySku = set.size ? lines.find((l) => l.productSku && set.has(norm(l.productSku))) : undefined;
  if (bySku) return { lineId: bySku.id, by: "sku" };
  const name = norm(productName);
  const byName = name ? lines.find((l) => norm(l.productName) === name || norm(l.description) === name) : undefined;
  return byName ? { lineId: byName.id, by: "name" } : null;
}
