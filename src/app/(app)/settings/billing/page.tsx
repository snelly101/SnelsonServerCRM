import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import { AUTOMATION_LEVELS, lastAutomationRun } from "@/services/billing-automation";
import { Card, DescriptionList } from "@/components/ui/page";
import { fmtDateTime } from "@/lib/format";
import { BillingAutomationForm, RunNowButton } from "./form";

export const metadata = { title: "Billing automation" };

export default async function BillingAutomationPage() {
  const me = await requirePermission("settings.read");
  const [settings, last] = await Promise.all([getAppSettings(), lastAutomationRun()]);
  const canWrite = can(me.role, "settings.write");
  return (
    <div className="space-y-4">
      <Card title="Billing automation policy" className="max-w-2xl">
        <p className="mb-4 text-sm text-slate-600">
          Automation moves in stages, from detecting issues to proposing resolutions to preparing drafts to approving the routine ones, and only as far as this policy allows. Each stage uses the same deterministic rules a person uses on the <Link href="/billing/run" className="text-brand-700 hover:underline">billing run</Link> and the <Link href="/billing" className="text-brand-700 hover:underline">draft review</Link>, and every automated action is audited as a system action naming the policy. The CRM never authorises or sends an invoice; that stays in Xero.
        </p>
        <BillingAutomationForm levels={AUTOMATION_LEVELS} settings={settings} readOnly={!canWrite} />
      </Card>
      <Card title="Last run" className="max-w-2xl">
        {last ? (
          <DescriptionList
            items={[
              { label: "When", value: `${fmtDateTime(last.value.at, settings)} (${last.value.trigger}) for ${last.value.asOf}` },
              { label: "Policy", value: `Level ${last.value.level}: ${AUTOMATION_LEVELS.find((l) => l.level === last.value.level)?.label ?? ""}` },
              { label: "Contracts", value: `${last.value.ready} ready · ${last.value.review} need review · ${last.value.blocked} blocked` },
              { label: "Prepared", value: String(last.value.prepared) },
              { label: "Created in Xero", value: `${last.value.approved}${last.value.approvalSkipped ? ` (${last.value.approvalSkipped} left for review)` : ""}` },
              { label: "Note", value: last.value.reason },
            ]}
          />
        ) : (
          <p className="text-sm text-slate-500">The policy has not run yet. The scheduled run happens daily at 07:00 and acts once a month on or after the run day.</p>
        )}
        {canWrite && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <RunNowButton />
          </div>
        )}
      </Card>
    </div>
  );
}
