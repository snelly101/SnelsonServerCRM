/**
 * Role-based permissions. Every server action and route handler must call
 * `assertCan(user, action)` before touching data. The UI uses `can()` only to
 * hide controls; it is never the enforcement point.
 */
export const ROLES = ["admin", "sales", "account_manager", "finance", "technician", "read_only"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  sales: "Sales",
  account_manager: "Account manager",
  finance: "Finance",
  technician: "Technician",
  read_only: "Read only",
};

export const ACTIONS = [
  // Companies, contacts, sites, tags
  "company.read",
  "company.write",
  "company.delete",
  "company.import",
  "company.export",
  "contact.read",
  "contact.write",
  "contact.delete",
  // Sales
  "opportunity.read",
  "opportunity.write",
  "opportunity.delete",
  "proposal.read",
  "proposal.create",
  // Contracts and catalogue
  "contract.read",
  "contract.write",
  "catalogue.read",
  "catalogue.write",
  // Tasks
  "task.read",
  "task.write",
  // Devices
  "device.read",
  // Finance (restricted)
  "finance.read",
  "invoice.prepare",
  "invoice.approve",
  "discrepancy.review",
  // Reporting
  "report.read",
  "report.finance.read",
  // Integrations and admin (restricted)
  "integration.read",
  "integration.manage",
  "integration.sync",
  "settings.read",
  "settings.write",
  "user.manage",
  "audit.read",
  // Secure Vault: `vault.use` = may hold per-user grants; `vault.admin` = manage grants, categories, settings, all audit
  "vault.use",
  "vault.admin",
  // Helpdesk: read = see tickets (Read-only Staff); agent = work tickets, reply, notes, time (Agent);
  // manage = team queues, bulk actions, assign others, merge/split, export (Team Manager);
  // admin = mailbox, SLA, automation, categories, deletion (Helpdesk Administrator)
  "helpdesk.read",
  "helpdesk.agent",
  "helpdesk.manage",
  "helpdesk.admin",
] as const;
export type Action = (typeof ACTIONS)[number];

const A = (...actions: Action[]) => new Set<Action>(actions);

const everyoneRead = [
  "company.read",
  "contact.read",
  "opportunity.read",
  "proposal.read",
  "contract.read",
  "catalogue.read",
  "task.read",
  "device.read",
  "report.read",
  "settings.read",
  "integration.read",
  "helpdesk.read",
] as const;

const PERMISSIONS: Record<Role, Set<Action>> = {
  admin: new Set(ACTIONS),
  sales: A(
    ...everyoneRead,
    "company.write",
    "company.import",
    "company.export",
    "contact.write",
    "opportunity.write",
    "opportunity.delete",
    "proposal.create",
    "task.write",
  ),
  account_manager: A(
    ...everyoneRead,
    "company.write",
    "company.export",
    "contact.write",
    "opportunity.write",
    "proposal.create",
    "contract.write",
    "task.write",
    "discrepancy.review",
    "invoice.prepare",
    "helpdesk.agent",
    "helpdesk.manage",
  ),
  finance: A(
    ...everyoneRead,
    "company.export",
    "contact.write",
    "contract.write",
    "catalogue.write",
    "finance.read",
    "invoice.prepare",
    "invoice.approve",
    "discrepancy.review",
    "report.finance.read",
    "task.write",
  ),
  technician: A(...everyoneRead, "contact.write", "task.write", "vault.use", "helpdesk.agent"),
  read_only: A(...everyoneRead),
};

export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return PERMISSIONS[role]?.has(action) ?? false;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(action: Action) {
    super(`You do not have permission to perform this action (${action}).`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: Role | null | undefined, action: Action): void {
  if (!can(role, action)) throw new ForbiddenError(action);
}

/** Actions listed on the Users admin page so an admin can see what each role does. */
export function actionsForRole(role: Role): Action[] {
  return ACTIONS.filter((a) => PERMISSIONS[role].has(a));
}
