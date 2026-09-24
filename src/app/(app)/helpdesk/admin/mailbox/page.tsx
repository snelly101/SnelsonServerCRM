import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import {
  listInboundQueue,
  listOutbox,
  mailboxHealth,
} from "@/services/mailbox";
import { listSyncRuns, recentUnresolvedErrors } from "@/services/integrations";
import { listUsers } from "@/services/users";
import { PageHeader, Card, DescriptionList, Stat } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { disconnectMailboxAction } from "@/actions/mailbox";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { param } from "@/lib/utils";
import {
  ConnectMailboxForm,
  MailboxButtons,
  MailboxSettingsForm,
  QueueTable,
  TestEmailForm,
} from "./forms";

export const metadata = { title: "Support mailbox" };

export default async function MailboxAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("helpdesk.admin");
  const sp = await searchParams;
  const [health, settings, users] = await Promise.all([
    mailboxHealth(),
    getAppSettings(),
    listUsers(),
  ]);
  const m = health?.mailbox ?? null;
  const [inbound, outbox, runs, errors] = m
    ? await Promise.all([
        listInboundQueue(m.id, param(sp, "inbound") ?? "all", 30),
        listOutbox(m.id, param(sp, "outbox") ?? "all", 30),
        listSyncRuns("m365", 8),
        recentUnresolvedErrors("m365", 10),
      ])
    : [[], [], [], []];
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const statusTone = !health
    ? "slate"
    : health.mode === "demo"
      ? "amber"
      : m?.status === "connected"
        ? "green"
        : m?.status === "not_configured" || m?.status === "disconnected"
          ? "slate"
          : "red";
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Helpdesk", href: "/helpdesk" },
          { label: "Administration", href: "/helpdesk/admin" },
          { label: "Mailbox" },
        ]}
        title={
          <span className="flex items-center gap-2">
            Support mailbox{" "}
            <Badge tone={statusTone}>
              {!health
                ? "not configured"
                : health.mode === "demo"
                  ? "Demo (not connected)"
                  : m?.status.replace("_", " ")}
            </Badge>
          </span>
        }
        description="The Microsoft 365 mailbox that receives customer e-mail and sends replies. Processing runs in the background worker whether or not anyone is signed in."
        actions={
          m ? <MailboxButtons id={m.id} live={health!.live} /> : undefined
        }
      />
      {health?.mode === "demo" && (
        <Alert tone="warn" title="Demo mailbox" className="mb-4">
          No Microsoft 365 mailbox is connected. Replies are recorded against an
          in-memory demo mailbox and go nowhere. Connect a real mailbox below to
          go live.
        </Alert>
      )}
      {m?.lastError && health?.live && (
        <Alert tone="error" title="Last error" className="mb-4">
          {m.lastError}
        </Alert>
      )}
      {m?.subscriptionError && health?.live && (
        <Alert tone="warn" title="Change notifications" className="mb-4">
          {m.subscriptionError}. Mail is still picked up by the 5-minute delta
          sync; use <em>Renew subscription</em> after fixing the cause (usually
          the webhook URL <code>{base}/api/webhooks/m365</code> not being
          reachable from the internet, or a revoked permission).
        </Alert>
      )}
      {health?.credentialExpiringSoon && (
        <Alert tone="warn" title="Credential expiring" className="mb-4">
          The app credential expires on{" "}
          {fmtDateTime(m!.credentialExpiresAt, settings)}. Create a new secret
          or certificate in Entra and reconnect before then.
        </Alert>
      )}
      {health?.live && health.staleInbound && (
        <Alert tone="warn" title="Inbound sync is stale" className="mb-4">
          No successful synchronisation in the last 20 minutes. Check that the
          worker is running (Integrations page shows its heartbeat) and use{" "}
          <em>Sync now</em>.
        </Alert>
      )}

      {health && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Stat
            label="Inbound queued"
            value={health.queue.pending + health.queue.processing}
            hint={
              health.queue.oldestPending
                ? `oldest ${fmtRelative(health.queue.oldestPending)}`
                : undefined
            }
            tone={health.queue.pending > 20 ? "warn" : "default"}
          />
          <Stat
            label="Inbound failed (dead)"
            value={health.queue.failed}
            tone={health.queue.failed ? "danger" : "default"}
          />
          <Stat label="Processed (24h)" value={health.queue.done24h} />
          <Stat
            label="Outbox queued / unknown"
            value={`${health.outbox.queued} / ${health.outbox.unknown}`}
            tone={health.outbox.unknown ? "warn" : "default"}
          />
          <Stat
            label="Outbound failed"
            value={health.outbox.failed}
            tone={health.outbox.failed ? "danger" : "default"}
          />
          <Stat
            label="Accepted by M365 (24h)"
            value={health.outbox.accepted24h}
            tone="good"
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Connection">
          {m && (
            <DescriptionList
              items={[
                {
                  label: "Mailbox",
                  value: `${m.displayName ? `${m.displayName} · ` : ""}${m.address}`,
                },
                { label: "Tenant", value: m.tenantId ?? null },
                {
                  label: "Credential",
                  value: health?.live
                    ? `${m.authMode}${m.credentialExpiresAt ? `, expires ${fmtDateTime(m.credentialExpiresAt, settings)}` : ""}`
                    : null,
                },
                {
                  label: "Permissions",
                  value: health?.live
                    ? m.status === "connected"
                      ? "read OK · send confirmed by the first accepted message"
                      : m.status
                    : null,
                },
                {
                  label: "Last tested",
                  value: m.lastTestedAt
                    ? fmtDateTime(m.lastTestedAt, settings)
                    : null,
                },
                {
                  label: "Last inbound sync",
                  value: m.lastInboundSyncAt
                    ? fmtDateTime(m.lastInboundSyncAt, settings)
                    : null,
                },
                {
                  label: "Last notification",
                  value: m.lastNotificationAt
                    ? fmtDateTime(m.lastNotificationAt, settings)
                    : null,
                },
                {
                  label: "Last outbound accepted",
                  value: m.lastOutboundAcceptedAt
                    ? fmtDateTime(m.lastOutboundAcceptedAt, settings)
                    : null,
                },
                {
                  label: "Subscription",
                  value: `${health?.subscriptionState}${m.subscriptionExpiresAt ? ` · renews before ${fmtDateTime(m.subscriptionExpiresAt, settings)}` : ""}`,
                },
                { label: "Webhook URL", value: `${base}/api/webhooks/m365` },
                {
                  label: "Monitored folders",
                  value: m.folders.map((f) => f.name).join(", "),
                },
                {
                  label: "Import cutoff",
                  value: m.importFrom
                    ? fmtDateTime(m.importFrom, settings)
                    : "from connection time",
                },
              ]}
            />
          )}
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <ConnectMailboxForm
              existing={
                m
                  ? {
                      address: m.address,
                      displayName: m.displayName,
                      tenantId: m.tenantId,
                      authMode: m.authMode,
                      importFrom: m.importFrom,
                    }
                  : null
              }
            />
            {m && health?.live && (
              <ConfirmButton
                variant="danger-outline"
                size="sm"
                action={disconnectMailboxAction.bind(null, m.id)}
                title="Disconnect the mailbox?"
                description="Credentials and the change subscription are removed. Tickets and their e-mail history are kept; new mail stops arriving until reconnected."
                confirmLabel="Disconnect"
              >
                Disconnect
              </ConfirmButton>
            )}
          </div>
          {m && (health?.live || health?.mode === "demo") && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <TestEmailForm
                id={m.id}
                staff={users
                  .filter((u) => u.active)
                  .map((u) => ({ email: u.email, name: u.name }))}
              />
            </div>
          )}
        </Card>
        <Card title="Behaviour">
          {m ? (
            <MailboxSettingsForm
              m={{
                id: m.id,
                displayName: m.displayName,
                folders: m.folders,
                importFrom: m.importFrom,
                ackEnabled: m.ackEnabled,
                ackSubject: m.ackSubject,
                ackBody: m.ackBody,
                unknownSenderPolicy: m.unknownSenderPolicy,
                closedReplyPolicy: m.closedReplyPolicy,
                closedReopenDays: m.closedReopenDays,
                signature: m.signature,
                credentialExpiresAt: m.credentialExpiresAt,
              }}
            />
          ) : (
            <p className="text-sm text-slate-500">Connect a mailbox first.</p>
          )}
        </Card>
      </div>

      <Card
        title="Inbound queue"
        padded={false}
        className="mt-4"
        actions={
          <span className="flex gap-1 text-xs">
            {["all", "pending", "done", "skipped", "dead"].map((s) => (
              <Link
                key={s}
                href={`/helpdesk/admin/mailbox?inbound=${s}`}
                className={`rounded px-2 py-0.5 ${(param(sp, "inbound") ?? "all") === s ? "bg-fg text-surface" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {s}
              </Link>
            ))}
          </span>
        }
      >
        <QueueTable
          kind="inbound"
          rows={inbound.map((r) => ({
            id: r.id,
            status: r.status,
            attempts: r.attempts,
            lastError: r.lastError,
            reference: r.reference,
            ticketSubject: r.ticketSubject,
            ticketId: r.ticketId,
            at: r.receivedAt,
            detail: r.outcome
              ? `${(r.outcome as { action?: string }).action ?? ""}${(r.outcome as { reason?: string }).reason ? `: ${(r.outcome as { reason?: string }).reason}` : ""}`
              : r.source,
          }))}
        />
      </Card>
      <Card
        title="Outbox"
        padded={false}
        className="mt-4"
        actions={
          <span className="flex gap-1 text-xs">
            {["all", "queued", "accepted", "unknown", "failed"].map((s) => (
              <Link
                key={s}
                href={`/helpdesk/admin/mailbox?outbox=${s}`}
                className={`rounded px-2 py-0.5 ${(param(sp, "outbox") ?? "all") === s ? "bg-fg text-surface" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {s}
              </Link>
            ))}
          </span>
        }
      >
        <QueueTable
          kind="outbox"
          rows={outbox.map((r) => ({
            id: r.id,
            status: r.status,
            attempts: r.attempts,
            lastError: r.lastError,
            reference: r.reference,
            ticketSubject: r.ticketSubject,
            ticketId: r.ticketId,
            at: r.createdAt,
            detail: `${r.kind} → ${r.toSummary ?? ""}${r.createdBy ? ` · ${r.createdBy}` : ""}`,
          }))}
        />
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Recent sync runs" padded={false}>
          {runs.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No runs yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-4 py-2">
                  <span className="w-24 text-xs text-slate-500">
                    {fmtRelative(r.startedAt)}
                  </span>
                  <Badge
                    tone={
                      r.status === "success"
                        ? "green"
                        : r.status === "partial"
                          ? "amber"
                          : r.status === "running"
                            ? "blue"
                            : "red"
                    }
                  >
                    {r.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-600">
                    {r.kind}: {r.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Unresolved errors" padded={false}>
          {errors.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">Nothing to show.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {errors.map((e) => (
                <li key={e.id} className="px-4 py-2">
                  <div className="text-red-700 [overflow-wrap:anywhere]">
                    {e.message}
                  </div>
                  <div className="text-xs text-slate-500">
                    {e.kind} · {fmtRelative(e.at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
