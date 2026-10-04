/** Renewal decision vocabulary, shared by server code and client components (no database imports here). */
export type RenewalDecision = "renew" | "amend" | "not_renewing";
export const DECISION_LABELS: Record<RenewalDecision, string> = { renew: "Renew as is", amend: "Renew with amendments", not_renewing: "Not renewing" };
export type RenewalMismatch = "supplier_outlasts" | "supplier_renews_first";
export const MISMATCH_LABELS: Record<RenewalMismatch, string> = { supplier_outlasts: "supplier commitment outlasts the agreement", supplier_renews_first: "supplier commitment renews before the agreement" };
