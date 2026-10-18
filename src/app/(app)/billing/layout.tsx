import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/ui/page";

/**
 * One Billing area with a fixed path through the month: needs attention,
 * customers, the run (prepare, approve, issued), services, renewals and
 * pricing, invoices, automation. The section pills are rendered by the app
 * shell (see components/nav-config.ts); pages inside render their own content only.
 */
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("finance.read");
  return (
    <>
      <PageHeader title="Billing" description="Contracts in, invoices out: what is due, what needs a decision, what has gone to Xero. Xero remains the source of truth for issued invoices and payments." />
      {children}
    </>
  );
}
