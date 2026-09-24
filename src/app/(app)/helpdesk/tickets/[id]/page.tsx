import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getAppSettings } from "@/lib/settings";
import {
  getDraft,
  getTicket,
  listCategories,
  listTeams,
} from "@/services/helpdesk";
import { listOwners } from "@/services/companies";
import { companyOptions, contactOptions } from "@/services/lookups";
import { listCustomFieldDefs } from "@/services/settings";
import { getDefaultMailbox, mailboxIsLive } from "@/services/mailbox";
import { Card } from "@/components/ui/page";
import { Alert } from "@/components/ui/alert";
import { StatusBadge, PriorityBadge } from "@/components/helpdesk/badges";
import { Conversation } from "./conversation";
import { Composer } from "./composer";
import { SidePanel } from "./side-panel";
import { MergeDialog, SplitDialog } from "./merge-split";
import { SlaPanel } from "./sla-panel";
import { Checklist } from "./checklist";
import { ticketSlaSummary } from "@/services/helpdesk-sla";
import { listChecklist, listTemplates } from "@/services/helpdesk-collab";
import { TRANSITIONS } from "@/lib/helpdesk-transitions";
import { markdownExcerpt } from "@/lib/markdown-parse";
import { param } from "@/lib/utils";
import type { TicketStatus } from "@/lib/validation-helpdesk";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTicket(id).catch(() => null);
  return { title: t ? `${t.reference} ${t.subject}` : "Ticket" };
}

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requirePermission("helpdesk.read");
  const { id } = await params;
  const sp = await searchParams;
  const t = await getTicket(id).catch(() => null);
  if (!t) notFound();
  const canEdit = can(me.role, "helpdesk.agent");
  const canManage = can(me.role, "helpdesk.manage");
  const mailbox = await getDefaultMailbox();
  const emailEnabled = Boolean(
    mailbox && (mailboxIsLive(mailbox) || process.env.DEMO_MODE === "true"),
  );
  const [
    settings,
    agents,
    teams,
    categories,
    companies,
    contacts,
    defs,
    draft,
    sla,
    checklist,
    templates,
  ] = await Promise.all([
    getAppSettings(),
    listOwners(),
    listTeams(),
    listCategories(),
    companyOptions(),
    contactOptions(),
    listCustomFieldDefs("ticket"),
    canEdit ? getDraft(id, me.id) : Promise.resolve(null),
    ticketSlaSummary(id),
    listChecklist(id),
    canEdit ? listTemplates({ activeOnly: true }) : Promise.resolve([]),
  ]);
  const showEvents = param(sp, "events") !== "0";
  const base = `/helpdesk/tickets/${id}`;
  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 py-2 text-xs text-slate-500"
      >
        <Link href="/helpdesk" className="hover:text-slate-800">
          Helpdesk
        </Link>
        <span aria-hidden>/</span>
        <Link href="/helpdesk/tickets" className="hover:text-slate-800">
          Tickets
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-800">{t.reference}</span>
      </nav>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-slate-900 [overflow-wrap:anywhere]">
            <span className="mr-2 font-mono text-base text-slate-500">
              {t.reference}
            </span>{" "}
            {t.subject}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            <span>
              {t.messages.length} message{t.messages.length === 1 ? "" : "s"}
            </span>
            {t.companyName && <span>· {t.companyName}</span>}
          </div>
        </div>
        {canManage && !t.mergedInto && (
          <div className="flex flex-wrap gap-2">
            <MergeDialog ticketId={t.id} reference={t.reference} />
            <SplitDialog
              ticketId={t.id}
              subject={t.subject}
              messages={t.messages.map((m) => ({
                id: m.id,
                kind: m.kind,
                label: `${m.authorName ?? m.fromName ?? m.fromEmail ?? "?"}: ${markdownExcerpt(m.bodyMarkdown ?? m.bodyText, 90)}`,
              }))}
            />
          </div>
        )}
      </header>
      {t.mergedInto && (
        <Alert tone="warn" title="This ticket was merged" className="mb-4">
          Its conversation now lives on{" "}
          <Link
            href={`/helpdesk/tickets/${t.mergedInto.id}`}
            className="font-medium underline"
          >
            {t.mergedInto.reference} {t.mergedInto.subject}
          </Link>
          . Replies to this reference are attached there.
        </Alert>
      )}
      {t.needsReview && !t.mergedInto && (
        <Alert tone="warn" title="Needs review" className="mb-4">
          {t.reviewReason ??
            "Confirm the requester and company before replying."}{" "}
          Use <em>Edit</em> in the requester panel to link the right contact,
          which clears this flag.
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card
            padded={false}
            title="Conversation"
            actions={
              <Link
                href={showEvents ? `${base}?events=0` : base}
                className="text-xs text-brand-700 hover:underline"
              >
                {showEvents ? "hide events" : "show events"}
              </Link>
            }
          >
            <div className="p-3">
              <Conversation
                messages={t.messages}
                events={t.events}
                settings={settings}
                showEvents={showEvents}
              />
            </div>
          </Card>
          {canEdit && !t.mergedInto && (
            <Card>
              <Composer
                ticketId={t.id}
                version={t.version}
                draft={
                  draft
                    ? {
                        kind: draft.kind,
                        body: draft.body,
                        ticketVersion: draft.ticketVersion,
                        updatedAt: draft.updatedAt,
                      }
                    : null
                }
                emailEnabled={emailEnabled}
                requesterEmail={t.requesterEmail}
                ccDefaults={t.participants
                  .filter((p) => p.role === "cc" && p.email)
                  .map((p) => p.email!)}
                allowedStatuses={TRANSITIONS[t.status as TicketStatus]}
                signature={mailbox?.signature ?? null}
                templates={templates.map((x) => ({
                  id: x.id,
                  name: x.name,
                  scope: x.scope,
                  body: x.body,
                  category: x.category,
                }))}
                openChecklist={checklist.filter((c) => !c.done).length}
              />
            </Card>
          )}
        </div>
        <div className="space-y-4">
          {sla && (
            <SlaPanel
              summary={sla}
              settings={settings}
              showHistory={showEvents}
              canAdmin={can(me.role, "helpdesk.admin")}
            />
          )}
          <Checklist
            ticketId={t.id}
            items={checklist.map((c) => ({
              id: c.id,
              title: c.title,
              done: c.done,
              assigneeUserId: c.assigneeUserId,
              assigneeName: c.assigneeName,
              dueDate: c.dueDate,
            }))}
            agents={agents}
            editable={canEdit && !t.mergedInto}
            settings={settings}
          />
        <SidePanel
          t={t}
          me={{ id: me.id, name: me.name }}
          canEdit={canEdit}
          canManage={canManage}
          agents={agents}
          teams={teams
            .filter((x) => x.active)
            .map((x) => ({ id: x.id, name: x.name }))}
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            children: c.children.map((s) => ({ id: s.id, name: s.name })),
          }))}
          companies={companies}
          contacts={contacts}
          customFields={defs.map((d) => ({
            key: d.key,
            label: d.label,
            type: d.type,
            options: d.options,
            required: d.required,
          }))}
          settings={settings}
        />
        </div>
      </div>
    </>
  );
}
