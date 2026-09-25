import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { helpdeskHealth } from "@/services/helpdesk-monitoring";
import { HELPDESK_RETENTION } from "@/services/helpdesk-retention";
import { getSystemStatus } from "@/lib/system-status";
import { PageHeader, Card, DescriptionList, Stat } from "@/components/ui/page";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/format";
import { DataRequestForm } from "./forms";

export const metadata = { title: "Helpdesk operations" };

export default async function HelpdeskOperationsPage() {
  await requirePermission("helpdesk.admin");
  const [health, settings, retention] = await Promise.all([
    helpdeskHealth(),
    getAppSettings(),
    getSystemStatus<{
      inboundDeleted: number;
      outboxDeleted: number;
      notificationsDeleted: number;
      automationRunsDeleted: number;
      draftsDeleted: number;
      ticketsAnonymised: number;
    }>("helpdesk.retention.last"),
  ]);
  const when = (iso: string | null) => (iso ? fmtDateTime(iso, settings) : "never");
  return (
    <>
      <nav aria-label="Breadcrumb" className="py-2 text-xs text-slate-500">
        <Link href="/settings/helpdesk" className="hover:text-slate-800">
          Helpdesk settings
        </Link>{" "}
        / Operations
      </nav>
      <PageHeader
        title="Helpdesk operations"
        description="Health of the jobs behind the helpdesk, the retention policy, and data-subject requests. The same facts are exposed to uptime monitors at /api/health."
      />
      {health.status === "degraded" ? (
        <Alert tone="warn" title="Attention needed" className="mb-4">
          <ul className="list-disc pl-5">
            {health.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="success" title="All helpdesk jobs healthy" className="mb-4">
          Mailbox, queues and scheduled jobs report no problems.
        </Alert>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Open tickets" value={health.tickets.open} />
        <Stat label="Needs review" value={health.tickets.needsReview} tone={health.tickets.needsReview ? "warn" : "default"} />
        <Stat label="Breaching SLA" value={health.tickets.breaching} tone={health.tickets.breaching ? "danger" : "default"} />
        <Stat label="Inbound dead" value={health.mailbox?.inboundDead ?? 0} tone={health.mailbox?.inboundDead ? "danger" : "default"} />
        <Stat label="Outbox unknown / failed" value={`${health.mailbox?.outboxUnknown ?? 0} / ${health.mailbox?.outboxFailed ?? 0}`} tone={(health.mailbox?.outboxUnknown ?? 0) + (health.mailbox?.outboxFailed ?? 0) ? "danger" : "default"} />
        <Stat label="Inbound pending" value={health.mailbox?.inboundPending ?? 0} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Scheduled jobs">
          <DescriptionList
            items={[
              { label: "SLA check (every 5 min)", value: when(health.slaCheckedAt) },
              { label: "Scheduled rules (every 15 min)", value: when(health.rulesRanAt) },
              { label: "Retention (nightly 03:15)", value: when(health.retentionRanAt) },
              {
                label: "Mailbox",
                value: health.mailbox ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge tone={health.mailbox.live ? "green" : "slate"}>{health.mailbox.live ? health.mailbox.status : "not live"}</Badge>
                    <Badge tone={health.mailbox.subscription === "active" || health.mailbox.subscription === "demo" ? "green" : "amber"}>subscription {health.mailbox.subscription}</Badge>
                    {health.mailbox.staleInbound && <Badge tone="red">inbound stale</Badge>}
                    {health.mailbox.credentialExpiringSoon && <Badge tone="amber">credential expiring</Badge>}
                    <Link href="/settings/helpdesk/mailbox" className="text-xs text-brand-700 hover:underline">
                      queues and replay
                    </Link>
                  </span>
                ) : (
                  "not configured"
                ),
              },
            ]}
          />
        </Card>
        <Card title="Retention policy">
          <DescriptionList
            items={[
              { label: "Finished inbound queue and outbox rows", value: `${HELPDESK_RETENTION.queueDays} days` },
              { label: "Read notifications", value: `${HELPDESK_RETENTION.notificationDays} days` },
              { label: "Automation run log", value: `${HELPDESK_RETENTION.automationRunDays} days` },
              { label: "Abandoned drafts", value: `${HELPDESK_RETENTION.draftDays} days` },
              {
                label: "Anonymise closed tickets after",
                value: HELPDESK_RETENTION.anonymiseAfterDays ? `${HELPDESK_RETENTION.anonymiseAfterDays} days (HELPDESK_ANONYMISE_AFTER_DAYS)` : "never (set HELPDESK_ANONYMISE_AFTER_DAYS to enable)",
              },
              {
                label: "Last run",
                value: retention
                  ? `${fmtDateTime(retention.updatedAt, settings)}: ${retention.value.inboundDeleted + retention.value.outboxDeleted} queue rows, ${retention.value.notificationsDeleted} notifications, ${retention.value.automationRunsDeleted} rule runs, ${retention.value.draftsDeleted} drafts, ${retention.value.ticketsAnonymised} tickets anonymised`
                  : "never",
              },
            ]}
          />
          <p className="mt-2 text-xs text-slate-500">
            Tickets, messages, events and time entries are never deleted by a job. Anonymising keeps the conversation text and history for reporting and removes who it was about.
          </p>
        </Card>
        <Card title="Data-subject request">
          <p className="mb-2 text-sm text-slate-600">
            Anonymise every ticket raised from an e-mail address, open ones included. Use it for a right-to-erasure request; each ticket is audited and marked.
          </p>
          <DataRequestForm />
        </Card>
      </div>
    </>
  );
}
