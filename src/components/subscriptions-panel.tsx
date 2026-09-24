import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import type { DisplaySettings } from "@/lib/format";
import type { companySubscriptionOverview } from "@/services/pax8";
import {
  ApplyCostButton,
  SubscriptionLineSelect,
} from "@/app/(app)/integrations/pax8/controls";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";

type Overview = NonNullable<
  Awaited<ReturnType<typeof companySubscriptionOverview>>
>;

const STATUS_TONE: Record<string, string> = {
  Active: "green",
  Activated: "green",
  PendingCancel: "amber",
  Trial: "blue",
  Cancelled: "slate",
  Converted: "slate",
};

export function SubscriptionsPanel({
  overview,
  canEdit,
  canReview,
  canManageIntegrations,
  settings,
  companyId,
}: {
  overview: Overview | null;
  canEdit: boolean;
  canReview: boolean;
  canManageIntegrations: boolean;
  settings: DisplaySettings & { currency: string };
  companyId: string;
}) {
  if (!overview) {
    return (
      <EmptyState
        title="Not linked to a Pax8 company"
        description="Licences bought through Pax8 appear here once this company is linked to its Pax8 account. Exact domain and name matches link automatically at sync time."
        action={
          canManageIntegrations ? (
            <ButtonLink href="/integrations/pax8" variant="secondary">
              Open Pax8 mapping
            </ButtonLink>
          ) : undefined
        }
      />
    );
  }
  const { pax8Company, subscriptions, lines, discrepancies, charges, totals } =
    overview;
  const money = (n: number | string | null | undefined) =>
    fmtMoney(n, settings.currency);
  const noLines = lines.length === 0;
  const lineOptions = lines.map((l) => ({
    id: l.id,
    description: l.description,
    contractName: l.contractName,
    contractStatus: l.contractStatus,
  }));
  return (
    <div className="space-y-4">
      {(totals.unbilled > 0 || totals.costStale > 0) && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {totals.unbilled > 0 && (
            <>
              <strong>
                {totals.unbilled} active subscription
                {totals.unbilled === 1 ? "" : "s"}
              </strong>{" "}
              {totals.unbilled === 1 ? "is" : "are"} not billed by any contract
              line.{" "}
            </>
          )}
          {totals.costStale > 0 && (
            <>
              <strong>{totals.costStale}</strong> contract line
              {totals.costStale === 1 ? "" : "s"} carr
              {totals.costStale === 1 ? "ies" : "y"} a unit cost that differs
              from the Pax8 price.
            </>
          )}
        </div>
      )}
      <Card
        title={`Subscriptions at Pax8 · ${totals.subscriptions} active, ${totals.licences} licence${totals.licences === 1 ? "" : "s"}, ${money(totals.monthlyCost)}/month cost`}
        padded={false}
        actions={
          <span className="flex items-center gap-2 text-xs text-slate-500">
            {overview.mode === "demo" && <Badge tone="amber">demo</Badge>}
            {totals.lastFetched
              ? `fetched ${fmtRelative(totals.lastFetched)}`
              : "never fetched"}
            {pax8Company.consoleUrl && (
              <a
                href={pax8Company.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-brand-700 hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Open in Pax8
              </a>
            )}
            {canManageIntegrations && (
              <Link
                href="/integrations/pax8"
                className="text-brand-700 hover:underline"
              >
                mapping
              </Link>
            )}
          </span>
        }
      >
        {noLines && canEdit && (
          <p className="border-b border-slate-100 px-4 py-2 text-xs text-amber-700">
            This company has no draft or active contract, so nothing can bill
            these licences yet.{" "}
            <Link
              href={`/contracts/new?companyId=${companyId}`}
              className="underline"
            >
              Create a contract
            </Link>{" "}
            with a per-user line for each product first.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="tbl table-fixed">
            <thead>
              <tr>
                <th>Product</th>
                <th className="w-[9%] text-right">Qty</th>
                <th className="w-[17%]">Term</th>
                <th className="w-[14%] text-right">Cost / unit</th>
                <th className="w-[32%]">Billed by</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="py-6 text-center text-sm text-slate-500"
                  >
                    No subscriptions mirrored for this company yet.
                  </td>
                </tr>
              )}
              {subscriptions.map((s) => (
                <tr key={s.id} className={s.billed ? "" : "opacity-60"}>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {s.productName}
                      </span>
                      <Badge tone={STATUS_TONE[s.status] ?? "slate"}>
                        {s.status}
                      </Badge>
                      {s.externalStatus !== "active" && (
                        <Badge tone="red">gone from Pax8</Badge>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">
                      {[s.vendorName, s.sku].filter(Boolean).join(" · ")}
                      {s.startDate &&
                        ` · since ${fmtDate(s.startDate, settings)}`}
                      {s.endDate && ` · ends ${fmtDate(s.endDate, settings)}`}
                    </div>
                  </td>
                  <td className="text-right tabular-nums">{s.quantity}</td>
                  <td className="text-xs">
                    <div>{s.billingTerm ?? "—"}</div>
                    {s.commitmentTerm && (
                      <div className="text-slate-500">
                        {s.commitmentTerm} commitment
                        {s.commitmentEndsOn
                          ? ` to ${fmtDate(s.commitmentEndsOn, settings)}`
                          : ""}
                      </div>
                    )}
                  </td>
                  <td className="text-right text-xs tabular-nums">
                    {s.price !== null ? (
                      <>
                        <div>{money(s.price)}</div>
                        {s.monthlyUnitCost !== null &&
                          s.billingTerm?.toLowerCase() !== "monthly" && (
                            <div className="text-slate-500">
                              ≈ {money(s.monthlyUnitCost)}/mo
                            </div>
                          )}
                        {s.line && s.marginPerUnitMonthly !== null && (
                          <div
                            className={
                              s.marginPerUnitMonthly < 0
                                ? "text-red-700"
                                : "text-slate-500"
                            }
                          >
                            margin {money(s.marginPerUnitMonthly)}/mo
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-400">n/a</span>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-col gap-1">
                      <SubscriptionLineSelect
                        subscriptionId={s.id}
                        value={s.contractLineId}
                        matchedLineId={s.line?.id ?? null}
                        matchedBy={s.matchedBy}
                        lines={lineOptions}
                        canEdit={canEdit}
                      />
                      {s.line && s.billed && s.monthlyUnitCost !== null && (
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                          <span>
                            line cost{" "}
                            {s.line.unitCost !== null
                              ? money(s.line.unitCost)
                              : "not set"}
                            {s.costDiffers && (
                              <Badge className="ml-1" tone="amber">
                                differs
                              </Badge>
                            )}
                          </span>
                          {canEdit && s.costDiffers && (
                            <ApplyCostButton
                              subscriptionId={s.id}
                              label="Use as cost"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {discrepancies.length > 0 && (
        <Card title="Contract vs licences at Pax8" padded={false}>
          <DiscrepancyTable
            rows={discrepancies}
            canReview={canReview}
            currency={settings.currency}
            compact
            kind="licence"
          />
        </Card>
      )}

      {charges.length > 0 && (
        <Card title="What Pax8 charged for this customer" padded={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Invoice date</th>
                <th>Invoice</th>
                <th className="text-right">Lines</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => (
                <tr key={c.invoiceId}>
                  <td className="whitespace-nowrap">
                    {c.invoiceDate ? fmtDate(c.invoiceDate, settings) : "—"}
                  </td>
                  <td className="text-xs text-slate-600">
                    {c.invoiceId}
                    {c.invoiceStatus && (
                      <Badge
                        className="ml-1"
                        tone={c.invoiceStatus === "Paid" ? "green" : "amber"}
                      >
                        {c.invoiceStatus}
                      </Badge>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{c.items}</td>
                  <td className="text-right tabular-nums">
                    {fmtMoney(c.total, c.currency ?? settings.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-slate-500">
            Partner cost as invoiced by Pax8, from the mirrored invoice lines
            for this company. Compare with the customer&apos;s Xero invoices on
            the Invoices tab.
          </p>
        </Card>
      )}
    </div>
  );
}
