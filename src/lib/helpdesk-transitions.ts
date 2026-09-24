import type { TicketStatus } from "./validation-helpdesk";

/** Allowed status moves (shared by the service and the UI). Reopening from resolved/closed/cancelled goes to open. */
const WAITING: TicketStatus[] = ["awaiting_customer", "awaiting_third_party"];
export const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  new: ["open", "in_progress", ...WAITING, "resolved", "cancelled"],
  open: ["in_progress", ...WAITING, "resolved", "cancelled"],
  in_progress: ["open", ...WAITING, "resolved", "cancelled"],
  awaiting_customer: [
    "open",
    "in_progress",
    "awaiting_third_party",
    "resolved",
    "cancelled",
  ],
  awaiting_third_party: [
    "open",
    "in_progress",
    "awaiting_customer",
    "resolved",
    "cancelled",
  ],
  resolved: ["closed", "open", "in_progress"],
  closed: ["open"],
  cancelled: ["open"],
};
export function canTransition(from: TicketStatus, to: TicketStatus) {
  return from === to || TRANSITIONS[from].includes(to);
}
