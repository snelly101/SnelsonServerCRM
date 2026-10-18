import {
  LayoutDashboard,
  Building2,
  Users,
  KanbanSquare,
  FileText,
  FileSignature,
  ListChecks,
  MonitorSmartphone,
  Landmark,
  BarChart3,
  Plug,
  Settings,
  LifeBuoy,
  type LucideIcon,
} from "lucide-react";
import { can, type Action, type Role } from "@/lib/permissions";

/** The icon rail: one entry per module. */
export const PRIMARY_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/pipeline", label: "Sales pipeline", icon: KanbanSquare },
  { href: "/proposals", label: "Proposals", icon: FileText },
  { href: "/contracts", label: "Contracts & services", icon: FileSignature },
  { href: "/tasks", label: "Tasks & onboarding", icon: ListChecks },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone },
  { href: "/helpdesk", label: "Helpdesk", icon: LifeBuoy },
  { href: "/billing", label: "Billing", icon: Landmark },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export type SectionItem = {
  href: string;
  label: string;
  /** Match this path only, not paths beneath it (used for a section's root). */
  exact?: boolean;
  /** Extra path prefixes this item is highlighted for. */
  also?: string[];
  /** Only shown to roles with this permission. */
  perm?: Action;
  /** Live count shown beside the label; filled in by the shell. */
  countKey?: "helpdeskOpen" | "unread";
};

export type SectionCounts = { helpdeskOpen?: number; unread?: number };

/**
 * The pill tabs in the top bar: the sub-sections of the current module.
 * Modules without sub-sections show their own name as the single active pill.
 */
const SECTIONS: { prefix: string; items: SectionItem[] }[] = [
  {
    prefix: "/helpdesk",
    items: [
      { href: "/helpdesk", label: "Dashboard", exact: true },
      { href: "/helpdesk/tickets", label: "Tickets", countKey: "helpdeskOpen" },
      { href: "/helpdesk/tickets/new", label: "New ticket", perm: "helpdesk.agent" },
      { href: "/helpdesk/kb", label: "Knowledge base" },
      { href: "/helpdesk/reports", label: "Reports" },
      { href: "/helpdesk/notifications", label: "Notifications", countKey: "unread" },
    ],
  },
  {
    prefix: "/billing",
    items: [
      { href: "/billing", label: "Needs attention", exact: true },
      { href: "/billing/customers", label: "Customers" },
      { href: "/billing/run", label: "Monthly run", also: ["/billing/drafts"], perm: "invoice.prepare" },
      { href: "/billing/services", label: "Services" },
      { href: "/billing/renewals", label: "Renewals & pricing" },
      { href: "/billing/invoices", label: "Invoices" },
      { href: "/settings/billing", label: "Automation", perm: "settings.read" },
    ],
  },
  {
    prefix: "/settings",
    items: [
      { href: "/settings", label: "General", exact: true },
      { href: "/settings/fields", label: "Tags & fields" },
      { href: "/settings/pipeline", label: "Pipeline stages", perm: "settings.write" },
      { href: "/settings/users", label: "Users & roles", perm: "user.manage" },
      { href: "/settings/security", label: "Security" },
      { href: "/settings/billing", label: "Billing automation" },
      { href: "/settings/audit", label: "Audit log", perm: "audit.read" },
      { href: "/settings/vault", label: "Secure Vault", perm: "vault.admin" },
      { href: "/settings/helpdesk", label: "Helpdesk", perm: "helpdesk.manage" },
    ],
  },
  {
    prefix: "/tasks",
    items: [
      { href: "/tasks", label: "Tasks & onboarding", exact: true, also: ["/tasks/onboarding"] },
      { href: "/tasks/templates", label: "Templates" },
    ],
  },
  {
    prefix: "/contracts",
    items: [
      { href: "/contracts", label: "Contracts", exact: true },
      { href: "/contracts/catalogue", label: "Catalogue" },
    ],
  },
  {
    prefix: "/account",
    items: [{ href: "/account/security", label: "Account security" }],
  },
];

function underPath(pathname: string, base: string) {
  return pathname === base || pathname.startsWith(base + "/");
}

/** Pills for the current path, filtered by role, with counts attached. */
export function sectionItems(pathname: string, role: Role, counts: SectionCounts): (SectionItem & { count?: number })[] {
  const section = SECTIONS.find((s) => underPath(pathname, s.prefix));
  if (section) {
    return section.items
      .filter((it) => !it.perm || can(role, it.perm))
      .map((it) => ({ ...it, count: it.countKey ? counts[it.countKey] : undefined }));
  }
  const primary = PRIMARY_NAV.find((n) => (n.href === "/" ? pathname === "/" : underPath(pathname, n.href)));
  return primary ? [{ href: primary.href, label: primary.label, exact: primary.href === "/" }] : [];
}

/** Whether a section item is active for the given path. Root items match exactly; others match their own subtree. */
export function sectionItemActive(pathname: string, it: SectionItem) {
  if (it.exact && pathname === it.href) return true;
  if (!it.exact && underPath(pathname, it.href)) return true;
  return (it.also ?? []).some((a) => underPath(pathname, a));
}
