// Compatibility shim for the service_coverage era: the engines now read service links.
export { linksByRow as coverageFor, isNonBillable, type ServiceLink as CoverageRow } from "./service-links";
export { NON_BILLABLE_ROLES as NON_BILLABLE_STATES } from "@/lib/billing-model";
