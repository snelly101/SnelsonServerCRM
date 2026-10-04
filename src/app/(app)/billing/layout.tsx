import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/page";
import { SettingsNav } from "@/app/(app)/settings/nav";

/**
 * One Billing area with a fixed path through the month: overview, the run
 * (prepare, approve, issued), exceptions, services, renewals and pricing,
 * invoices, automation. Pages inside render their own content only.
 */
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  const me = await requirePermission("finance.read");
  const items = [
    { href: "/billing", label: "Overview" },
    ...(can(me.role, "invoice.prepare") ? [{ href: "/billing/run", label: "Monthly run", also: ["/billing/drafts"] }] : []),
    { href: "/billing/exceptions", label: "Exceptions" },
    { href: "/billing/services", label: "Services" },
    { href: "/billing/renewals", label: "Renewals & pricing" },
    { href: "/billing/invoices", label: "Invoices" },
    ...(can(me.role, "settings.read") ? [{ href: "/settings/billing", label: "Automation ↗" }] : []),
  ];
  return (
    <>
      <PageHeader title="Billing" description="Contracts in, invoices out: what is due, what needs a decision, what has gone to Xero. Xero remains the source of truth for issued invoices and payments." />
      <div className="grid gap-6 lg:grid-cols-[190px_1fr]">
        <SettingsNav items={items} />
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
