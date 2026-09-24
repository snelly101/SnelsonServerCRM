"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AtSign,
  UserCheck,
  MailOpen,
  AlarmClock,
  AlertTriangle,
  Eye,
  Zap,
  MailX,
  ListChecks,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { markNotificationsReadAction } from "@/actions/helpdesk-collab";
import { fmtDateTime, type DisplaySettings } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICONS: Record<string, typeof Bell> = {
  mention: AtSign,
  assigned: UserCheck,
  customer_replied: MailOpen,
  sla_due: AlarmClock,
  sla_breached: AlertTriangle,
  followed_update: Eye,
  automation: Zap,
  bounce: MailX,
  checklist: ListChecks,
};

export function NotificationList({
  rows,
  settings,
}: {
  rows: {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    ticketId: string | null;
    actorName: string | null;
    readAt: string | null;
    createdAt: string;
  }[];
  settings: DisplaySettings;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const unread = rows.filter((r) => !r.readAt).length;
  const mark = (ids: string[] | "all") =>
    start(async () => {
      await markNotificationsReadAction(ids);
      router.refresh();
    });
  return (
    <>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
        <span>
          {unread ? `${unread} unread` : "Nothing unread"} · {rows.length} shown
        </span>
        {unread > 0 && (
          <Button
            size="sm"
            variant="ghost"
            loading={pending}
            onClick={() => mark("all")}
          >
            Mark all read
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-slate-500">
          No notifications yet. Follow a ticket, get assigned or get mentioned
          with @name in a note and they show up here.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label="Notifications">
          {rows.map((r) => {
            const Icon = ICONS[r.kind] ?? Bell;
            return (
              <li
                key={r.id}
                className={cn(
                  "flex items-start gap-3 px-4 py-2.5 text-sm",
                  !r.readAt && "bg-brand-50/40",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    r.kind === "sla_breached" || r.kind === "bounce"
                      ? "text-red-600"
                      : r.kind === "sla_due"
                        ? "text-amber-600"
                        : "text-slate-500",
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  {r.ticketId ? (
                    <Link
                      href={`/helpdesk/tickets/${r.ticketId}`}
                      className={cn(
                        "hover:underline",
                        !r.readAt ? "font-medium text-slate-900" : "text-slate-700",
                      )}
                      onClick={() => {
                        if (!r.readAt) void markNotificationsReadAction([r.id]);
                      }}
                    >
                      {r.title}
                    </Link>
                  ) : (
                    <span className={!r.readAt ? "font-medium" : undefined}>
                      {r.title}
                    </span>
                  )}
                  {r.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                      {r.body}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {fmtDateTime(r.createdAt, settings)}
                    {r.actorName && ` · ${r.actorName}`}
                  </p>
                </div>
                {!r.readAt && (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-brand-700 hover:underline"
                    onClick={() => mark([r.id])}
                  >
                    Mark read
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
