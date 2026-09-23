import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import type { DisplaySettings } from "@/lib/format";
import type { companyHostingOverview } from "@/services/twentyi";
import { BillingLineSelect, ConsoleLink } from "@/app/(app)/integrations/twentyi/controls";
import { expiryTone, fmtBytes, HOSTING_KIND_TONE } from "@/lib/hosting-format";

type Overview = NonNullable<Awaited<ReturnType<typeof companyHostingOverview>>>;
type Item = Overview["looseDomains"][number];

function ItemRow({ item, lines, canEdit, settings, indent = false }: { item: Item; lines: Overview["lines"]; canEdit: boolean; settings: DisplaySettings; indent?: boolean }) {
  const exp = expiryTone(item.expiresOn);
  return (
    <tr className={item.externalStatus !== "active" ? "opacity-60" : ""}>
      <td className={indent ? "pl-8" : ""}>
        <div className="flex items-center gap-1.5">
          <Badge tone={HOSTING_KIND_TONE[item.kind]}>{item.kind}</Badge>
          <span className="font-medium">{item.name}</span>
          {item.enabled === false && <Badge tone="amber">disabled</Badge>}
          {item.externalStatus !== "active" && <Badge tone="red">gone from 20i</Badge>}
        </div>
        <div className="text-xs text-slate-500">
          {item.typeName ?? ""}
          {item.kind === "package" && item.diskUsedBytes !== null && ` · ${fmtBytes(item.diskUsedBytes)} used${item.diskLimitBytes ? ` of ${fmtBytes(item.diskLimitBytes)}` : ""}`}
          {item.kind === "package" && item.createdExternal && ` · since ${fmtDate(item.createdExternal, settings)}`}
          {item.consoleUrl && (
            <>
              {" · "}
              <ConsoleLink href={item.consoleUrl} />
            </>
          )}
        </div>
      </td>
      <td className="text-xs">
        {item.kind === "domain" || item.kind === "ssl" ? (
          exp ? (
            <span className="flex items-center gap-1">
              {fmtDate(item.expiresOn, settings)} <Badge tone={exp.tone}>{exp.label}</Badge>
            </span>
          ) : (
            <span className="text-slate-400">unknown</span>
          )
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td>{item.kind === "mailbox" ? <span className="text-xs text-slate-400">via package</span> : <BillingLineSelect itemId={item.id} value={item.contractLineId} lines={lines.map((l) => ({ id: l.id, description: l.description, contractName: l.contractName, contractStatus: l.contractStatus }))} canEdit={canEdit} />}</td>
    </tr>
  );
}

export function HostingPanel({ overview, canEdit, canManageIntegrations, settings, companyId }: { overview: Overview | null; canEdit: boolean; canManageIntegrations: boolean; settings: DisplaySettings & { currency: string }; companyId: string }) {
  if (!overview) {
    return <EmptyState title="No 20i hosting linked" description="Packages and domains from the 20i reseller account appear here once they are linked to this company. Exact domain matches link automatically at sync time." action={canManageIntegrations ? <ButtonLink href="/integrations/twentyi" variant="secondary">Open 20i mapping</ButtonLink> : undefined} />;
  }
  const { packages, looseDomains, orphanMailboxes, expiring, lines, invoices, totals } = overview;
  const noLines = lines.length === 0;
  return (
    <div className="space-y-4">
      {expiring.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <strong>{expiring.length} renewal{expiring.length === 1 ? "" : "s"} due within 30 days:</strong> {expiring.map((e) => `${e.name} (${e.expired ? "expired " : ""}${e.expiresOn})`).join(", ")}. Renew in My20i and make sure the line below bills it.
        </div>
      )}
      <Card
        title={`Hosting at 20i · ${totals.packages} package${totals.packages === 1 ? "" : "s"}, ${totals.domains} domain${totals.domains === 1 ? "" : "s"}, ${totals.mailboxes} mailbox${totals.mailboxes === 1 ? "" : "es"}`}
        padded={false}
        actions={
          <span className="flex items-center gap-2 text-xs text-slate-500">
            {overview.mode === "demo" && <Badge tone="amber">demo</Badge>}
            {totals.lastFetched ? `fetched ${fmtRelative(new Date(totals.lastFetched))}` : "never fetched"}
            {canManageIntegrations && (
              <Link href="/integrations/twentyi" className="text-brand-700 hover:underline">
                mapping
              </Link>
            )}
          </span>
        }
      >
        {noLines && canEdit && (
          <p className="border-b border-slate-100 px-4 py-2 text-xs text-amber-700">
            This company has no draft or active contract, so nothing can bill these items yet. <Link href={`/contracts/new?companyId=${companyId}`} className="underline">Create a contract</Link> with a hosting or domain line first.
          </p>
        )}
        <table className="tbl">
          <thead>
            <tr>
              <th>Item</th>
              <th>Expires</th>
              <th>Billed by</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <FragmentRows key={p.id} pkg={p} lines={lines} canEdit={canEdit} settings={settings} />
            ))}
            {looseDomains.map((d) => (
              <ItemRow key={d.id} item={d} lines={lines} canEdit={canEdit} settings={settings} />
            ))}
            {orphanMailboxes.map((m) => (
              <ItemRow key={m.id} item={m} lines={lines} canEdit={canEdit} settings={settings} />
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Invoices mentioning this hosting" padded={false}>
        {invoices.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No mirrored Xero invoice line mentions a package or domain name above. Invoices raised from a contract line chosen under &ldquo;Billed by&rdquo; will show here once the line description includes the domain.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Status</th>
                <th>Date</th>
                <th>Mentions</th>
                <th className="text-right">Total</th>
                <th className="text-right">Due</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => {
                const overdue = i.status === "AUTHORISED" && i.dueDate && i.dueDate < new Date().toISOString().slice(0, 10);
                return (
                  <tr key={i.invoiceId}>
                    <td className="font-medium">
                      {i.onlineInvoiceUrl ? (
                        <a href={i.onlineInvoiceUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                          {i.invoiceNumber ?? i.invoiceId.slice(0, 8)}
                        </a>
                      ) : (
                        (i.invoiceNumber ?? i.invoiceId.slice(0, 8))
                      )}
                    </td>
                    <td>
                      <Badge tone={overdue ? "red" : i.status === "PAID" ? "green" : i.status === "AUTHORISED" ? "indigo" : "slate"}>{overdue ? "overdue" : i.status.toLowerCase()}</Badge>
                    </td>
                    <td>{fmtDate(i.date, settings)}</td>
                    <td className="text-xs text-slate-600">{i.mentions.join(", ")}</td>
                    <td className="text-right tabular-nums">{fmtMoney(i.total, i.currencyCode ?? settings.currency)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(i.amountDue, i.currencyCode ?? settings.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function FragmentRows({ pkg, lines, canEdit, settings }: { pkg: Overview["packages"][number]; lines: Overview["lines"]; canEdit: boolean; settings: DisplaySettings }) {
  return (
    <>
      <ItemRow item={pkg} lines={lines} canEdit={canEdit} settings={settings} />
      {pkg.domains.map((d) => (
        <ItemRow key={d.id} item={d} lines={lines} canEdit={canEdit} settings={settings} indent />
      ))}
      {pkg.mailboxes.map((m) => (
        <ItemRow key={m.id} item={m} lines={lines} canEdit={canEdit} settings={settings} indent />
      ))}
    </>
  );
}
