/**
 * Which of a customer's contract lines an integration's service probably
 * belongs on, for the matching screens to offer first. Pure and cheap: the
 * same SKU and name rules the sync uses, plus looser name and kind matches a
 * person can confirm with one click. Active agreements rank above drafts.
 */
export type SuggestableLine = {
  id: string;
  description: string;
  contractStatus: string;
  productSku?: string | null;
  productName?: string | null;
};

export type SuggestableService = {
  name: string;
  kind: string;
  supplierProduct: string | null;
  matchKeys?: string[];
};

/** Strength 3: the sync's own rules (SKU, exact name). 2: the line names the service. 1: a hint worth showing, never worth a one-click button. */
export type Suggestion = { lineId: string; reason: string; strength: 3 | 2 | 1 };

/** A suggestion safe to apply from a single click: only the strong ones. */
export const confident = (s: Suggestion | undefined) => Boolean(s && s.strength >= 2);

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** Words that appear in half the catalogue and say nothing about which line a service belongs on. */
const GENERIC = new Set(["microsoft", "365", "office", "business", "plan", "standard", "premium", "basic", "licence", "license", "subscription", "seat", "seats", "user", "users", "per", "monthly", "annual", "cloud", "service", "services", "managed", "for", "and", "the", "with"]);
const words = (s: string) => norm(s).replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !GENERIC.has(w));

/** Suggestions ordered best first; a line appears at most once. */
export function suggestLines(service: SuggestableService, lines: SuggestableLine[]): Suggestion[] {
  const keys = new Set([...(service.matchKeys ?? []), service.supplierProduct].map(norm).filter(Boolean));
  const name = norm(service.name);
  const kind = norm(service.kind);
  const out: Suggestion[] = [];
  for (const l of lines) {
    const desc = norm(l.description);
    let s: Suggestion | null = null;
    if (l.productSku && keys.has(norm(l.productSku))) s = { lineId: l.id, reason: "same catalogue SKU", strength: 3 };
    else if (name && (norm(l.productName) === name || desc === name)) s = { lineId: l.id, reason: "same name", strength: 3 };
    else if (name && (desc.includes(name) || name.includes(desc) && desc.length > 3)) s = { lineId: l.id, reason: "similar name", strength: 2 };
    else {
      const sw = new Set(words(service.name));
      const shared = words(l.description).filter((w) => sw.has(w));
      if (shared.length >= 2) s = { lineId: l.id, reason: `shares “${shared.slice(0, 2).join("”, “")}”`, strength: 1 };
      else if (kind.includes("domain") && desc.includes("domain")) s = { lineId: l.id, reason: "a domain line", strength: 1 };
      else if (kind.includes("hosting") && /hosting|web|website/.test(desc)) s = { lineId: l.id, reason: "a hosting line", strength: 1 };
      else if (kind.includes("device") && /device|workstation|server|endpoint/.test(desc)) s = { lineId: l.id, reason: "a device line", strength: 1 };
    }
    if (s) out.push(s);
  }
  const status = new Map(lines.map((l) => [l.id, l.contractStatus]));
  return out.sort((a, b) => b.strength - a.strength || (status.get(a.lineId) === "active" ? 0 : 1) - (status.get(b.lineId) === "active" ? 0 : 1));
}
