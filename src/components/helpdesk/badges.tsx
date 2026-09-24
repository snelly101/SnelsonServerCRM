import { Badge } from "@/components/ui/badge";
import {
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_TONES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_TONES,
  TICKET_TYPE_LABELS,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
} from "@/lib/validation-helpdesk";

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge
      tone={TICKET_STATUS_TONES[status as TicketStatus] ?? "slate"}
      className={className}
    >
      {TICKET_STATUS_LABELS[status as TicketStatus] ?? status}
    </Badge>
  );
}
export function PriorityBadge({
  priority,
  className,
}: {
  priority: string;
  className?: string;
}) {
  return (
    <Badge
      tone={TICKET_PRIORITY_TONES[priority as TicketPriority] ?? "slate"}
      className={className}
    >
      {TICKET_PRIORITY_LABELS[priority as TicketPriority] ?? priority}
    </Badge>
  );
}
export function TypeBadge({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  return (
    <Badge tone="slate" className={className}>
      {TICKET_TYPE_LABELS[type as TicketType] ?? type}
    </Badge>
  );
}

/** "due in 2h" / "overdue by 1d" for an SLA deadline; null when there is none. */
export function dueLabel(
  due: Date | string | null | undefined,
  done: boolean,
): { text: string; tone: "green" | "amber" | "red" | "slate" } | null {
  if (!due) return null;
  if (done) return { text: "met", tone: "green" };
  const ms = new Date(due).getTime() - Date.now();
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const span =
    h >= 48
      ? `${Math.floor(h / 24)}d`
      : h >= 1
        ? `${h}h${m ? ` ${m}m` : ""}`
        : `${m}m`;
  if (ms < 0) return { text: `overdue by ${span}`, tone: "red" };
  if (ms < 4 * 3600000) return { text: `due in ${span}`, tone: "amber" };
  return { text: `due in ${span}`, tone: "slate" };
}
