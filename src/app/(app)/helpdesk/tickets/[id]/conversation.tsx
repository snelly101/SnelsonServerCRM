import {
  Paperclip,
  Mail,
  Phone,
  StickyNote,
  Cog,
  ArrowDownLeft,
  ArrowUpRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MarkdownLite } from "@/lib/markdown-lite";
import { fmtDateTime, fmtRelative, type DisplaySettings } from "@/lib/format";
import type { TicketDetail } from "@/services/helpdesk";
import { EmailHtml } from "@/components/helpdesk/email-html";

type Message = TicketDetail["messages"][number];
type Event = TicketDetail["events"][number];

/** Conversation and events interleaved by time. E-mail HTML bodies render in the mailbox stage; here Markdown and plain text. */
export function Conversation({
  messages,
  events,
  settings,
  showEvents,
}: {
  messages: Message[];
  events: Event[];
  settings: DisplaySettings;
  showEvents: boolean;
}) {
  const items: (
    | { kind: "m"; at: Date; m: Message }
    | { kind: "e"; at: Date; e: Event }
  )[] = [
    ...messages.map((m) => ({ kind: "m" as const, at: new Date(m.at), m })),
    ...(showEvents
      ? events
          .filter((e) => !["message", "note"].includes(e.kind))
          .map((e) => ({ kind: "e" as const, at: new Date(e.at), e }))
      : []),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (items.length === 0)
    return <p className="p-4 text-sm text-slate-500">No messages yet.</p>;
  return (
    <ol className="space-y-3" aria-label="Conversation">
      {items.map((it) =>
        it.kind === "e" ? (
          <li
            key={`e-${it.e.id}`}
            className="flex items-center gap-2 px-2 text-xs text-slate-500"
          >
            <Cog className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {it.e.summary}
              {it.e.actorName
                ? ` · ${it.e.actorName}`
                : it.e.actorType !== "user"
                  ? ` · ${it.e.actorType}`
                  : ""}
            </span>
            <time
              dateTime={it.at.toISOString()}
              title={fmtDateTime(it.at, settings)}
            >
              {fmtRelative(it.at)}
            </time>
          </li>
        ) : (
          <MessageCard key={it.m.id} m={it.m} settings={settings} />
        ),
      )}
    </ol>
  );
}

function MessageCard({
  m,
  settings,
}: {
  m: Message;
  settings: DisplaySettings;
}) {
  const internal = m.kind === "internal";
  const Icon = internal
    ? StickyNote
    : m.channel === "email"
      ? Mail
      : m.channel === "manual"
        ? Phone
        : Cog;
  const who =
    m.authorName ??
    m.fromName ??
    m.fromEmail ??
    (m.direction === "inbound" ? "Customer" : "Agent");
  const merged = (m.metadata as { mergedFrom?: string } | null)?.mergedFrom;
  return (
    <li
      id={`message-${m.id}`}
      className={`rounded-lg border ${internal ? "border-amber-200 bg-amber-50/60" : m.direction === "inbound" ? "border-slate-200 bg-surface" : "border-brand-200 bg-brand-50/40"}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-black/5 px-3 py-2 text-xs">
        <Icon className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        <span className="font-medium text-slate-800">{who}</span>
        {m.fromEmail && m.fromName && (
          <span className="text-slate-500">{m.fromEmail}</span>
        )}
        {internal ? (
          <Badge tone="amber">internal note</Badge>
        ) : m.direction === "inbound" ? (
          <Badge tone="slate">
            <ArrowDownLeft className="mr-0.5 h-3 w-3" />
            from customer
          </Badge>
        ) : (
          <Badge tone="blue">
            <ArrowUpRight className="mr-0.5 h-3 w-3" />
            {m.channel === "manual" ? "logged, not e-mailed" : "to customer"}
          </Badge>
        )}
        {m.isAutomated && (
          <Badge tone="slate">
            automated{m.automatedReason ? `: ${m.automatedReason}` : ""}
          </Badge>
        )}
        {m.deliveryStatus !== "not_applicable" && (
          <Badge
            tone={
              m.deliveryStatus === "accepted"
                ? "green"
                : m.deliveryStatus === "failed" ||
                    m.deliveryStatus === "bounced"
                  ? "red"
                  : "amber"
            }
          >
            {m.deliveryStatus.replace("_", " ")}
          </Badge>
        )}
        {merged && <Badge tone="slate">from {merged}</Badge>}
        <time
          className="ml-auto text-slate-500"
          dateTime={new Date(m.at).toISOString()}
          title={fmtDateTime(m.at, settings)}
        >
          {fmtRelative(m.at)}
        </time>
      </header>
      {!internal &&
        (m.toRecipients.length > 0 || m.ccRecipients.length > 0) && (
          <p className="px-3 pt-2 text-[11px] text-slate-500">
            to {m.toRecipients.map((r) => r.email).join(", ")}
            {m.ccRecipients.length > 0 && (
              <> · cc {m.ccRecipients.map((r) => r.email).join(", ")}</>
            )}
          </p>
        )}
      <div className="px-3 py-2 text-sm">
        {m.bodyMarkdown ? (
          <MarkdownLite text={m.bodyMarkdown} />
        ) : m.bodyHtml ? (
          <EmailHtml
            html={m.bodyHtml}
            cidBase={`/api/helpdesk/attachments/cid/${m.id}?cid=`}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-slate-800">
            {m.bodyText}
          </pre>
        )}
        {m.quotedText && (
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer select-none">
              Show quoted text
            </summary>
            <pre className="mt-1 whitespace-pre-wrap font-sans">
              {m.quotedText}
            </pre>
          </details>
        )}
      </div>
      {m.attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-t border-black/5 px-3 py-2 text-xs">
          {m.attachments.map((a) => (
            <li
              key={a.id}
              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-surface px-2 py-1"
            >
              <Paperclip className="h-3 w-3 text-slate-400" aria-hidden />
              {a.scanStatus === "clean" || a.scanStatus === "skipped" ? (
                <a
                  href={`/api/helpdesk/attachments/${a.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {a.fileName}
                </a>
              ) : (
                <span className="text-slate-600">{a.fileName}</span>
              )}
              <span className="text-slate-400">
                {Math.max(1, Math.round(a.sizeBytes / 1024))} KB
              </span>
              {a.scanStatus === "blocked" && (
                <Badge tone="red">
                  blocked{a.scanDetail ? `: ${a.scanDetail}` : ""}
                </Badge>
              )}
              {a.scanStatus === "error" && (
                <Badge tone="amber">
                  not stored{a.scanDetail ? `: ${a.scanDetail}` : ""}
                </Badge>
              )}
              {a.scanStatus === "pending" && (
                <Badge tone="slate">scanning</Badge>
              )}
              {a.restricted && <Badge tone="amber">internal</Badge>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
