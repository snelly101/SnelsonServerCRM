import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip } from "lucide-react";
import { requirePortalAccount } from "@/lib/portal-auth";
import { portalGetTicket } from "@/services/portal";
import { getAppSettings } from "@/lib/settings";
import { fmtBytes, fmtDateTime, fmtRelative } from "@/lib/format";
import { MarkdownLite } from "@/lib/markdown-lite";
import { StatusBadge, PriorityBadge } from "@/components/helpdesk/badges";
import { Alert } from "@/components/ui/alert";
import { ReplyForm } from "./reply-form";
import { FeedbackForm } from "./feedback-form";

export const metadata = { title: "Request" };

const STATUS_HELP: Record<string, string> = {
  new: "Received. An engineer will pick this up shortly.",
  open: "An engineer is looking at this.",
  in_progress: "Being worked on now.",
  awaiting_customer: "We need something from you. Reply below.",
  awaiting_third_party: "Waiting on a supplier or third party.",
  resolved: "Resolved. Reply if the problem comes back and we will reopen it.",
  closed: "Closed. Reply to reopen it or raise a new request.",
  cancelled: "Cancelled.",
};

export default async function PortalTicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const account = await requirePortalAccount(`/portal/tickets/${id}`);
  const [t, settings] = await Promise.all([portalGetTicket(account, id), getAppSettings()]);
  if (!t) notFound();
  return (
    <div className="space-y-4">
      <Link href="/portal" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:underline"><ArrowLeft className="h-4 w-4" /> All requests</Link>
      <div className="rounded-lg border border-slate-200 bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-mono text-xs text-slate-500">{t.reference}</div>
            <h1 className="text-lg font-semibold text-slate-900">{t.subject}</h1>
            <div className="mt-1 text-xs text-slate-500">
              Raised {fmtDateTime(t.createdAt, settings)}{!t.isMine && t.requesterName ? ` by ${t.requesterName}` : ""}{t.assigneeName ? ` · handled by ${t.assigneeName}` : ""} · last update {fmtRelative(t.lastActivityAt)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {t.priority !== "normal" && <PriorityBadge priority={t.priority} />}
            <StatusBadge status={t.status} />
          </div>
        </div>
        <p className="mt-3 text-sm text-slate-700">{STATUS_HELP[t.status] ?? ""}</p>
        {t.resolutionSummary && ["resolved", "closed"].includes(t.status) && (
          <div className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
            <span className="font-medium">Resolution:</span> {t.resolutionSummary}
          </div>
        )}
      </div>

      {sp.refused && <Alert tone="warn" title="Some attachments were not accepted">{sp.refused}</Alert>}

      {t.canRate && <FeedbackForm ticketId={t.id} existing={t.feedback} />}

      <ol className="space-y-3">
        {t.messages.map((m) => (
          <li key={m.id} className={`rounded-lg border p-4 ${m.fromCustomer ? "border-slate-200 bg-surface" : "border-brand-200 bg-brand-50/40"}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-800">{m.fromCustomer ? m.author : `${m.author} (${settings.companyName})`}</span>
              <time dateTime={m.at.toISOString()}>{fmtDateTime(m.at, settings)}</time>
            </div>
            {m.bodyMarkdown ? <MarkdownLite text={m.bodyMarkdown} className="space-y-2 text-sm leading-relaxed text-slate-800" /> : <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{m.bodyText}</p>}
            {m.attachments.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {m.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={`/api/portal/attachments/${a.id}`} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" download>
                      <Paperclip className="h-3 w-3" /> {a.fileName} <span className="text-slate-400">({fmtBytes(a.sizeBytes)})</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {t.looseAttachments.length > 0 && (
          <li className="rounded-lg border border-slate-200 bg-surface p-4">
            <div className="mb-2 text-xs font-medium text-slate-800">Files on this request</div>
            <ul className="flex flex-wrap gap-2">
              {t.looseAttachments.map((a) => (
                <li key={a.id}>
                  <a href={`/api/portal/attachments/${a.id}`} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" download>
                    <Paperclip className="h-3 w-3" /> {a.fileName} <span className="text-slate-400">({fmtBytes(a.sizeBytes)})</span>
                  </a>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ol>

      {t.canReply ? <ReplyForm ticketId={t.id} reopens={["resolved", "closed"].includes(t.status)} /> : <p className="text-sm text-slate-500">This request was cancelled. <Link href="/portal/tickets/new" className="text-brand-700 hover:underline">Raise a new one</Link> if you still need help.</p>}
    </div>
  );
}
