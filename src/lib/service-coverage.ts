import type { CoverageState } from "@/db/schema/coverage";

/** States a supplied service can be in: two derived from the billing-line mappings, five recorded explicitly in `service_coverage`. */
export type ServiceState = "charged" | CoverageState | "unmapped";

export const SERVICE_STATE_LABELS: Record<ServiceState, string> = {
  charged: "Charged on a line",
  bundle: "Included in a bundle",
  commitment: "Covered by commitment",
  free: "Intentionally free",
  internal: "Internal / non-billable",
  investigate: "Needs investigation",
  unmapped: "Unmapped",
};
