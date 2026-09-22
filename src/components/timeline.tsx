import { FileText, Phone, Mail, Users, StickyNote, Cog, ListChecks, Receipt, FileSignature, MonitorSmartphone, RefreshCw } from "lucide-react";
import { EmptyState } from "./ui/page";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  note: StickyNote,
  call: Phone,
  email: Mail,
  meeting: Users,
  system: Cog,
  task: ListChecks,
  proposal: FileText,
  invoice: Receipt,
  contract: FileSignature,
  device: MonitorSmartphone,
  sync: RefreshCw,
};

export type TimelineItem = {
  id: string;
  at: string;
  type: string;
  title: string;
  body: string | null;
  source: string;
  actorName: string | null;
};

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="Nothing on the timeline yet" description="Notes, calls, proposals, invoices and sync events will appear here." />
      </div>
    );
  }
  return (
    <ol className="divide-y divide-slate-100">
      {items.map((it) => {
        const Icon = ICONS[it.type] ?? Cog;
        return (
          <li key={it.id} className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-slate-800">{it.title}</div>
              {it.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600">{it.body}</p>}
              <div className="mt-0.5 text-xs text-slate-500">
                {it.at}
                {it.actorName ? ` · ${it.actorName}` : it.source !== "user" ? ` · ${it.source}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
