"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RefreshCw,
  Stethoscope,
  Link2,
  Unlink,
  ExternalLink,
  Coins,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  Select,
  Input,
  SubmitButton,
  FormMessage,
  Checkbox,
} from "@/components/ui/form";
import {
  applyPax8CostAction,
  connectPax8Action,
  linkPax8CompanyAction,
  recheckLicencesAction,
  savePax8ConfigAction,
  setSubscriptionBillingLineAction,
  syncPax8Action,
  testPax8Action,
  unlinkPax8CompanyAction,
} from "@/actions/pax8";

export function Pax8TestButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await testPax8Action();
            setMsg(
              r.ok
                ? { ok: r.data.ok, text: r.data.message }
                : { ok: false, text: r.error },
            );
            router.refresh();
          })
        }
      >
        <Stethoscope className="h-3.5 w-3.5" /> Test
      </Button>
      {msg && (
        <span
          className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}
        >
          {msg.text}
        </span>
      )}
    </span>
  );
}

export function Pax8SyncButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await syncPax8Action();
            setMsg(r.ok ? r.data.message : r.error);
            router.refresh();
          })
        }
      >
        <RefreshCw className="h-3.5 w-3.5" /> Sync now
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function RecheckLicencesButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await recheckLicencesAction();
            setMsg(
              r.ok
                ? `${r.data.checked} lines checked, ${r.data.open} open, ${r.data.resolved} resolved`
                : r.error,
            );
            router.refresh();
          })
        }
      >
        <RefreshCw className="h-3.5 w-3.5" /> Re-check licences
      </Button>
      {msg && <span className="text-xs text-slate-600">{msg}</span>}
    </span>
  );
}

export function Pax8ConnectForm({ keyPresent }: { keyPresent: boolean }) {
  const [result, formAction] = useActionState(connectPax8Action, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <Field label="Client ID" htmlFor="p8-id">
        <Input
          id="p8-id"
          name="clientId"
          required
          autoComplete="off"
          placeholder={
            keyPresent
              ? "Paste a new client id to replace the stored one"
              : "From the Pax8 partner portal"
          }
        />
      </Field>
      <Field
        label="Client secret"
        htmlFor="p8-secret"
        help="Stored encrypted on the server. Never shown again."
      >
        <Input
          id="p8-secret"
          name="clientSecret"
          type="password"
          required
          autoComplete="new-password"
        />
      </Field>
      <p className="text-xs text-slate-500">
        In the Pax8 partner portal:{" "}
        <strong>Settings → Integrations → Pax8 API</strong> → create an API
        client and copy its id and secret. The CRM exchanges them for a token at{" "}
        <code>login.pax8.com</code> and only ever reads: companies,
        subscriptions, products and invoices. It never orders, changes
        quantities or cancels anything.
      </p>
      <SubmitButton size="sm">
        {keyPresent ? "Replace credentials" : "Verify and connect"}
      </SubmitButton>
    </form>
  );
}

export function Pax8ConfigForm({
  autoLink,
  invoiceCount,
  readOnly,
}: {
  autoLink: boolean;
  invoiceCount: number;
  readOnly: boolean;
}) {
  const [result, formAction] = useActionState(savePax8ConfigAction, null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <fieldset disabled={readOnly} className="space-y-3">
        <Checkbox
          name="autoLink"
          value="true"
          defaultChecked={autoLink}
          label="Link Pax8 companies to a CRM company automatically when the website domain or the exact name matches one company"
        />
        <Field
          label="Recent partner invoices to mirror"
          htmlFor="p8-inv"
          help="Charge lines from these invoices give the per-customer cost view on the Subscriptions tab. 0 turns it off."
        >
          <Input
            id="p8-inv"
            name="invoiceCount"
            type="number"
            min={0}
            max={24}
            defaultValue={invoiceCount}
            className="w-28"
          />
        </Field>
      </fieldset>
      {!readOnly && <SubmitButton size="sm">Save</SubmitButton>}
    </form>
  );
}

type CompanyRow = {
  id: string;
  pax8Id: string;
  name: string;
  website: string | null;
  city: string | null;
  status: string | null;
  externalStatus: string;
  companyId: string | null;
  companyName: string | null;
  matchSource: string | null;
  subscriptions: number;
  licences: number;
  suggestions: {
    id: string;
    name: string;
    reason: "domain" | "name" | "similar";
  }[];
  consoleUrl: string | null;
};

const REASON_LABEL = {
  domain: "domain match",
  name: "exact name",
  similar: "similar name",
} as const;
const REASON_TONE = {
  domain: "green",
  name: "green",
  similar: "amber",
} as const;

export function Pax8MappingTable({
  rows,
  companies,
  canManage,
}: {
  rows: CompanyRow[];
  companies: { id: string; name: string }[];
  canManage: boolean;
}) {
  const [filter, setFilter] = useState<"all" | "unlinked" | "linked">("all");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const router = useRouter();
  const shown = rows.filter((r) =>
    filter === "all"
      ? true
      : filter === "linked"
        ? Boolean(r.companyId)
        : !r.companyId,
  );
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? null : (r.error ?? "Failed"));
      router.refresh();
    });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2 text-sm">
        {(["all", "unlinked", "linked"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-2 py-0.5 ${filter === f ? "bg-fg text-surface" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {f}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">
          Exact domain or exact name matches are linked at sync time; similar
          names are only suggestions. One Pax8 company per CRM company.
        </span>
      </div>
      {msg && <p className="px-4 py-2 text-sm text-red-700">{msg}</p>}
      <table className={`tbl ${pending ? "opacity-70" : ""}`}>
        <thead>
          <tr>
            <th>Pax8 company</th>
            <th className="text-right">Subscriptions</th>
            <th className="text-right">Licences</th>
            <th>CRM company</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td
                colSpan={5}
                className="py-6 text-center text-sm text-slate-500"
              >
                {rows.length === 0
                  ? "Nothing mirrored yet. Run a sync."
                  : "Nothing matches this filter."}
              </td>
            </tr>
          )}
          {shown.map((r) => (
            <tr key={r.id} className="align-top">
              <td>
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-slate-500">
                  {[r.website, r.city].filter(Boolean).join(" · ")}
                  {r.status && r.status !== "Active" && (
                    <Badge className="ml-1" tone="amber">
                      {r.status} at Pax8
                    </Badge>
                  )}
                  {r.externalStatus !== "active" && (
                    <Badge className="ml-1" tone="red">
                      gone from Pax8
                    </Badge>
                  )}
                  {r.consoleUrl && (
                    <>
                      {" · "}
                      <a
                        href={r.consoleUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-brand-700 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" /> Open in Pax8
                      </a>
                    </>
                  )}
                </div>
              </td>
              <td className="text-right tabular-nums">{r.subscriptions}</td>
              <td className="text-right tabular-nums">{r.licences}</td>
              <td>
                {r.companyId ? (
                  <span className="flex items-center gap-1">
                    <Link
                      href={`/companies/${r.companyId}?tab=subscriptions`}
                      className="text-brand-700 hover:underline"
                    >
                      {r.companyName}
                    </Link>
                    {r.matchSource === "auto" && (
                      <Badge tone="green">auto</Badge>
                    )}
                  </span>
                ) : canManage ? (
                  <div className="space-y-1">
                    {r.suggestions.length > 0 && (
                      <ul className="space-y-0.5">
                        {r.suggestions.map((s) => (
                          <li
                            key={s.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            <Badge tone={REASON_TONE[s.reason]}>
                              {REASON_LABEL[s.reason]}
                            </Badge>
                            <span>{s.name}</span>
                            <button
                              type="button"
                              className="inline-flex items-center gap-0.5 text-brand-700 hover:underline"
                              onClick={() =>
                                run(() => linkPax8CompanyAction(r.id, s.id))
                              }
                            >
                              <Link2 className="h-3 w-3" /> Link
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-1">
                      <Select
                        aria-label={`Company for ${r.name}`}
                        className="h-8 w-auto max-w-[220px] text-xs"
                        value={choice[r.id] ?? ""}
                        onChange={(e) =>
                          setChoice((c) => ({ ...c, [r.id]: e.target.value }))
                        }
                      >
                        <option value="">— choose company —</option>
                        {companies.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!choice[r.id]}
                        onClick={() =>
                          run(() => linkPax8CompanyAction(r.id, choice[r.id]))
                        }
                      >
                        <Link2 className="h-3.5 w-3.5" /> Link
                      </Button>
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-amber-700">not linked</span>
                )}
              </td>
              <td className="text-right">
                {canManage && r.companyId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(() => unlinkPax8CompanyAction(r.id))}
                  >
                    <Unlink className="h-3.5 w-3.5" /> Unlink
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Company page: choose which contract line bills a subscription (overrides SKU / name matching). */
export function SubscriptionLineSelect({
  subscriptionId,
  value,
  matchedLineId,
  matchedBy,
  lines,
  canEdit,
}: {
  subscriptionId: string;
  value: string | null;
  matchedLineId: string | null;
  matchedBy: string | null;
  lines: {
    id: string;
    description: string;
    contractName: string;
    contractStatus: string;
  }[];
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const matched = lines.find((l) => l.id === matchedLineId);
  const hint =
    matchedBy && matchedBy !== "manual" ? (
      <span className="text-[11px] text-slate-500">
        matched by {matchedBy === "sku" ? "SKU" : "product name"}
      </span>
    ) : null;
  if (!canEdit)
    return (
      <span className="flex flex-col text-xs">
        {matched ? (
          <span>
            {matched.description}{" "}
            <span className="text-slate-500">({matched.contractName})</span>
          </span>
        ) : (
          <span className="text-amber-700">not billed</span>
        )}
        {hint}
      </span>
    );
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5">
      <Select
        aria-label="Billed by contract line"
        className={`py-1 text-xs ${pending ? "opacity-60" : ""}`}
        value={value ?? ""}
        onChange={(e) =>
          start(async () => {
            const r = await setSubscriptionBillingLineAction(
              subscriptionId,
              e.target.value || null,
            );
            setError(r.ok ? null : r.error);
            router.refresh();
          })
        }
      >
        <option value="">
          {matched ? `— automatic: ${matched.description} —` : "— not billed —"}
        </option>
        {lines.map((l) => (
          <option key={l.id} value={l.id} title={l.contractName}>
            {l.description}
            {l.contractStatus === "draft" ? " (draft)" : ""} · {l.contractName}
          </option>
        ))}
      </Select>
      {hint}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

/** Copies the Pax8 partner cost onto the matched contract line. */
export function ApplyCostButton({
  subscriptionId,
  label,
}: {
  subscriptionId: string;
  label: string;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        title="Set the contract line's unit cost from the Pax8 price (the sell price is never changed)"
        onClick={() =>
          start(async () => {
            const r = await applyPax8CostAction(subscriptionId);
            setMsg(
              r.ok
                ? { ok: true, text: `cost now ${r.data.unitCost}` }
                : { ok: false, text: r.error },
            );
            router.refresh();
          })
        }
      >
        <Coins className="h-3.5 w-3.5" /> {label}
      </Button>
      {msg && (
        <span
          className={`text-[11px] ${msg.ok ? "text-green-700" : "text-red-700"}`}
        >
          {msg.text}
        </span>
      )}
    </span>
  );
}
