import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePortalAccount } from "@/lib/portal-auth";
import { portalListTickets, portalTicketCounts } from "@/services/portal";
import { getAppSettings } from "@/lib/settings";
import { fmtRelative } from "@/lib/format";
import { StatusBadge, PriorityBadge } from "@/components/helpdesk/badges";
import { ButtonLink } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "My requests" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ view?: string; q?: string; scope?: string }> }) {
  const account = await requirePortalAccount("/portal");
  const sp = await searchParams;
  const view = sp.view === "resolved" || sp.view === "all" ? sp.view : "open";
  const scope = account.isCompanyAdmin && sp.scope === "mine" ? "mine" : "company";
  const [rows, counts] = await Promise.all([portalListTickets(account, { view, q: sp.q ?? null, scope }), portalTicketCounts(account)]);
  void getAppSettings;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Hello {account.name.split(" ")[0]}</h1>
          <p className="text-sm text-slate-500">
            {counts.open} open request{counts.open === 1 ? "" : "s"}
            {counts.awaiting ? <>, <span className="font-medium text-amber-700">{counts.awaiting} waiting for your reply</span></> : null}
            {account.isCompanyAdmin ? ` · you can see every request from ${account.companyName}` : ""}
          </p>
        </div>
        <ButtonLink href="/portal/tickets/new"><Plus className="h-4 w-4" /> New request</ButtonLink>
      </div>

      <form className="flex flex-wrap items-center gap-2" method="get">
        <Select name="view" defaultValue={view} aria-label="Which requests" className="w-auto">
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </Select>
        {account.isCompanyAdmin && (
          <Select name="scope" defaultValue={scope} aria-label="Whose requests" className="w-auto">
            <option value="company">Everyone at {account.companyName}</option>
            <option value="mine">Only mine</option>
          </Select>
        )}
        <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search by subject or number" aria-label="Search" className="w-64" />
        <button type="submit" className="rounded-md border border-slate-300 bg-surface px-3 py-2 text-sm hover:bg-slate-50">Filter</button>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-surface px-6 py-12 text-center text-sm text-slate-500">
          {view === "open" ? "No open requests. " : "Nothing here. "}
          <Link href="/portal/tickets/new" className="text-brand-700 hover:underline">Raise a new request</Link> or <Link href="/portal/kb" className="text-brand-700 hover:underline">browse the help articles</Link>.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-surface">
          {rows.map((t) => (
            <li key={t.id}>
              <Link href={`/portal/tickets/${t.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-slate-50">
                <span className="w-24 shrink-0 font-mono text-xs text-slate-500">{t.reference}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">{t.subject}</span>
                  <span className="block text-xs text-slate-500">
                    {account.isCompanyAdmin && !t.isMine && t.requesterName ? `${t.requesterName} · ` : ""}updated {fmtRelative(t.lastActivityAt)}
                    {t.status === "awaiting_customer" ? " · we are waiting for you" : ""}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  {t.priority !== "normal" && <PriorityBadge priority={t.priority} />}
                  <StatusBadge status={t.status} />
                  {["resolved", "closed"].includes(t.status) && !t.hasFeedback && <Badge tone="indigo">rate us</Badge>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
