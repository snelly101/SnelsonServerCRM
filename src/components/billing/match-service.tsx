"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { CoverageForm, type LineOption } from "@/components/service-register";
import { createLineForServiceAction, setServiceLineAction } from "@/actions/coverage";
import { suggestLines } from "@/lib/service-suggest";
import { fmtMoney } from "@/lib/format";
import { FREQUENCY_LABELS, PRICING_LABELS } from "@/lib/validation-sales";
import type { RegisterRow } from "@/services/service-register";

export type ContractOption = { id: string; name: string; status: string; billingFrequency: string };
export type CatalogueOption = { id: string; name: string; sku: string | null; pricingModel: string; billingFrequency: string; unitPrice: string; unitCost: string | null; countsAsManagedDevice: boolean };

type Frequency = "monthly" | "quarterly" | "annual";
const MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, annual: 12 };
const NEW = "__new__";
const today = () => new Date().toISOString().slice(0, 10);

/** What a new line should look like before anyone types: the service's own name, count and cost, with the catalogue product when the SKU is known. */
function defaults(row: RegisterRow, products: CatalogueOption[]) {
  const keys = new Set([...(row.matchKeys ?? []), row.supplierProduct].filter(Boolean).map((k) => String(k).toLowerCase()));
  const product = products.find((p) => p.sku && keys.has(p.sku.toLowerCase())) ?? null;
  const frequency: Frequency = product ? ((product.billingFrequency === "one_off" ? "monthly" : product.billingFrequency) as Frequency) : row.kind.toLowerCase().includes("domain") ? "annual" : "monthly";
  const pricingModel = product ? product.pricingModel : row.source === "pax8_subscription" ? "per_user" : row.source === "ninja_device" ? "per_device" : "fixed";
  const monthlyUnitCost = row.monthlyCost !== null && row.quantity ? row.monthlyCost / row.quantity : null;
  return {
    productId: product?.id ?? "",
    description: product?.name ?? row.name,
    quantity: String(row.quantity || 1),
    unitPrice: product ? String(Number(product.unitPrice)) : row.customerMonthlyPrice !== null && row.customerMonthlyPrice !== undefined ? String(Math.round(row.customerMonthlyPrice * MONTHS[frequency] * 100) / 100) : "",
    unitCost: product?.unitCost !== null && product?.unitCost !== undefined ? String(Number(product.unitCost)) : monthlyUnitCost !== null ? String(Math.round(monthlyUnitCost * MONTHS[frequency] * 100) / 100) : "",
    frequency,
    pricingModel,
    synced: row.source === "pax8_subscription",
    countsAsManagedDevice: product?.countsAsManagedDevice ?? row.source === "ninja_device",
  };
}

/**
 * One dialog for everything a person can do with a supplied service: charge
 * it on an existing line (best guesses first), create the line it should be
 * charged on (on an agreement, or a new draft one), or record that it is
 * not charged separately. Opened from the service register and the company
 * Billing tab.
 */
export function MatchServiceDialog({ row, lines, contracts, products, currency, trigger, variant = "secondary" }: { row: RegisterRow; lines: LineOption[]; contracts: ContractOption[]; products: CatalogueOption[]; currency: string; trigger?: string; variant?: "secondary" | "ghost" | "primary" }) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(() => suggestLines(row, lines), [row, lines]);
  const unmapped = row.state === "unmapped" || row.state === "investigate";
  const initialTab = lines.length === 0 ? "new" : "existing";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        {trigger ?? (unmapped ? "Match" : "Change")}
      </Button>
      <DialogContent wide title={row.name} description={`${row.kind}${row.supplierProduct ? ` · ${row.supplierProduct}` : ""}${row.companyName ? ` · ${row.companyName}` : ""} · ${row.quantity} supplied${row.monthlyCost !== null ? ` · ${fmtMoney(row.monthlyCost, currency)}/month supplier cost` : ""}`}>
        <Tabs defaultValue={initialTab}>
          <TabsList>
            <TabsTrigger value="existing">Charge on a line</TabsTrigger>
            <TabsTrigger value="new">Create the line</TabsTrigger>
            <TabsTrigger value="other">Not charged separately</TabsTrigger>
          </TabsList>
          <TabsContent value="existing">
            <ExistingLine row={row} lines={lines} suggestions={suggestions} onDone={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="new">
            <NewLine row={row} contracts={contracts} products={products} currency={currency} onDone={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="other">
            <CoverageForm row={row} lines={lines} onDone={() => setOpen(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ExistingLine({ row, lines, suggestions, onDone }: { row: RegisterRow; lines: LineOption[]; suggestions: ReturnType<typeof suggestLines>; onDone: () => void }) {
  const current = row.state === "charged" ? (row.line?.id ?? "") : "";
  const [lineId, setLineId] = useState<string>(current || suggestions[0]?.lineId || "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const why = new Map(suggestions.map((s) => [s.lineId, s.reason]));
  const byContract = new Map<string, LineOption[]>();
  for (const l of lines) byContract.set(l.contractName, [...(byContract.get(l.contractName) ?? []), l]);
  const suggested = suggestions.map((s) => lines.find((l) => l.id === s.lineId)).filter((l): l is LineOption => Boolean(l));
  if (lines.length === 0) return <p className="text-sm text-slate-600">This customer has no draft or active agreement lines yet. Use <strong>Create the line</strong> to add one.</p>;
  return (
    <div className="space-y-3">
      <Field label="Contract line that bills this service" htmlFor={`match-line-${row.key}`} help={suggested.length ? "Likely matches are listed first." : "Nothing on this customer's agreements looks like it; pick a line or create one."}>
        <Select id={`match-line-${row.key}`} value={lineId} onChange={(e) => setLineId(e.target.value)}>
          <option value="">— choose —</option>
          {suggested.length > 0 && (
            <optgroup label="Suggested">
              {suggested.map((l) => (
                <option key={`s-${l.id}`} value={l.id}>
                  {l.description} · {l.contractName}
                  {l.contractStatus === "draft" ? " (draft)" : ""} — {why.get(l.id)}
                </option>
              ))}
            </optgroup>
          )}
          {[...byContract].map(([name, list]) => (
            <optgroup key={name} label={name}>
              {list.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.description}
                  {l.contractStatus === "draft" ? " (draft)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      {lineId && why.get(lineId) && (
        <p className="flex items-center gap-1.5 text-xs text-slate-600">
          <Sparkles className="h-3.5 w-3.5 text-brand-500" aria-hidden /> Suggested because it has the {why.get(lineId)}.
        </p>
      )}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button variant="secondary">Cancel</Button>
        </DialogClose>
        <Button
          loading={pending}
          disabled={!lineId || lineId === current}
          onClick={() =>
            start(async () => {
              const r = await setServiceLineAction(row.source, row.rowId, lineId);
              if (!r.ok) return setError(r.error);
              const l = lines.find((x) => x.id === lineId);
              toast(`${row.name} charged on ${l?.description ?? "that line"}; counts re-checked`);
              onDone();
              router.refresh();
            })
          }
        >
          <Link2 className="h-4 w-4" /> Charge on this line
        </Button>
      </div>
    </div>
  );
}

function NewLine({ row, contracts, products, currency, onDone }: { row: RegisterRow; contracts: ContractOption[]; products: CatalogueOption[]; currency: string; onDone: () => void }) {
  const d = useMemo(() => defaults(row, products), [row, products]);
  const firstContract = contracts.find((c) => c.status === "active") ?? contracts[0] ?? null;
  const [contractId, setContractId] = useState<string>(firstContract?.id ?? NEW);
  const [newName, setNewName] = useState(`${row.companyName ?? "Managed services"} agreement`);
  const [newStart, setNewStart] = useState(today());
  const [newFrequency, setNewFrequency] = useState<Frequency>("monthly");
  const [productId, setProductId] = useState(d.productId);
  const [description, setDescription] = useState(d.description);
  const [quantity, setQuantity] = useState(d.quantity);
  const [unitPrice, setUnitPrice] = useState(d.unitPrice);
  const [unitCost, setUnitCost] = useState(d.unitCost);
  const [frequency, setFrequency] = useState<Frequency>(d.frequency);
  const [pricingModel, setPricingModel] = useState(d.pricingModel);
  const [synced, setSynced] = useState(d.synced);
  const [managedDevice, setManagedDevice] = useState(d.countsAsManagedDevice);
  const [ownCycle, setOwnCycle] = useState(true);
  const [startsOn, setStartsOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const contract = contracts.find((c) => c.id === contractId) ?? null;
  const contractFrequency = contract ? contract.billingFrequency : newFrequency;
  const differentCycle = frequency !== contractFrequency;
  const months = MONTHS[frequency];
  const perPeriod = Number(quantity || 0) * Number(unitPrice || 0);
  const pickProduct = (id: string) => {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (!p) return;
    setDescription(p.name);
    setUnitPrice(String(Number(p.unitPrice)));
    if (p.unitCost !== null) setUnitCost(String(Number(p.unitCost)));
    if (p.billingFrequency !== "one_off") setFrequency(p.billingFrequency as Frequency);
    setPricingModel(p.pricingModel);
    setManagedDevice(p.countsAsManagedDevice);
  };
  const id = (k: string) => `nl-${k}-${row.key}`;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="On agreement" htmlFor={id("contract")} className="md:col-span-2">
          <Select id={id("contract")} value={contractId} onChange={(e) => setContractId(e.target.value)}>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === "draft" ? " (draft)" : ""} · {FREQUENCY_LABELS[c.billingFrequency as keyof typeof FREQUENCY_LABELS] ?? c.billingFrequency}
              </option>
            ))}
            <option value={NEW}>— new draft agreement —</option>
          </Select>
        </Field>
        {contractId === NEW && (
          <>
            <Field label="Agreement name" htmlFor={id("name")}>
              <Input id={id("name")} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={200} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date" htmlFor={id("start")}>
                <Input id={id("start")} type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
              </Field>
              <Field label="Invoiced" htmlFor={id("cfreq")}>
                <Select id={id("cfreq")} value={newFrequency} onChange={(e) => setNewFrequency(e.target.value as Frequency)}>
                  {(["monthly", "quarterly", "annual"] as const).map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABELS[f]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </>
        )}
        <Field label="Catalogue product (optional)" htmlFor={id("product")} help="Fills the price, cost and model from the catalogue." className="md:col-span-2">
          <Select id={id("product")} value={productId} onChange={(e) => pickProduct(e.target.value)}>
            <option value="">— none —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.sku ? ` (${p.sku})` : ""} · {fmtMoney(Number(p.unitPrice), currency)}/{p.billingFrequency === "annual" ? "yr" : p.billingFrequency === "quarterly" ? "qtr" : "mo"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" htmlFor={id("desc")} className="md:col-span-2">
          <Input id={id("desc")} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </Field>
        {contract?.status === "active" && (
          <Field label="Starts on" htmlFor={id("starts")} help="The day the customer started having it. The next invoice bills it pro rata from this day, a whole period after that." className="md:col-span-2">
            <Input id={id("starts")} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className="w-44" />
          </Field>
        )}
        <Field label="Quantity" htmlFor={id("qty")} help={`${row.quantity} supplied by ${row.providerLabel}`}>
          <Input id={id("qty")} type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Billed" htmlFor={id("freq")}>
          <Select id={id("freq")} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            {(["monthly", "quarterly", "annual"] as const).map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABELS[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Unit price (${currency}, per ${months === 12 ? "year" : months === 3 ? "quarter" : "month"})`} htmlFor={id("price")} help={[perPeriod ? `${fmtMoney(perPeriod, currency)} per ${months === 12 ? "year" : months === 3 ? "quarter" : "month"} for ${quantity || 0}` : null, !productId && row.customerMonthlyPrice ? `Pax8's customer price; change it to yours.` : null].filter(Boolean).join(" · ") || undefined}>
          <Input id={id("price")} type="number" min={0} step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} required />
        </Field>
        <Field label={`Unit cost (${currency}, per ${months === 12 ? "year" : months === 3 ? "quarter" : "month"})`} htmlFor={id("cost")} help={row.monthlyCost !== null ? "From the supplier's price; leave empty if unknown." : "Leave empty if unknown; margin is then an estimate."}>
          <Input id={id("cost")} type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        </Field>
        <Field label="Pricing model" htmlFor={id("model")}>
          <Select id={id("model")} value={pricingModel} onChange={(e) => setPricingModel(e.target.value)}>
            {(["per_user", "per_device", "fixed"] as const).map((m) => (
              <option key={m} value={m}>
                {PRICING_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          {row.source !== "ninja_device" && <Checkbox label="Bill whatever the integration reports (synced quantity)" checked={synced} onChange={(e) => setSynced(e.target.checked)} />}
          {pricingModel === "per_device" && <Checkbox label="Compare with NinjaOne's device count" checked={managedDevice} onChange={(e) => setManagedDevice(e.target.checked)} />}
          {differentCycle && <Checkbox label={`Invoice on its own ${FREQUENCY_LABELS[frequency].toLowerCase()} cycle (otherwise spread over the agreement's invoices)`} checked={ownCycle} onChange={(e) => setOwnCycle(e.target.checked)} />}
        </div>
      </div>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">{contract?.status === "active" ? `The line is dated from ${startsOn || "today"}; the next invoice pro-rates it.` : "The agreement is a draft; nothing is invoiced until it is active."}</span>
        <span className="flex gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            loading={pending}
            disabled={!description.trim() || unitPrice === ""}
            onClick={() =>
              start(async () => {
                const r = await createLineForServiceAction({
                  source: row.source,
                  sourceRowId: row.rowId,
                  contractId: contractId === NEW ? null : contractId,
                  newContract: contractId === NEW ? { name: newName, startDate: newStart, billingFrequency: newFrequency } : null,
                  effectiveFrom: contract?.status === "active" ? startsOn || null : null,
                  line: { productId: productId || "", siteId: "", description, revenueType: "recurring", pricingModel: pricingModel as "per_user" | "per_device" | "fixed", billingFrequency: frequency, quantity: Number(quantity), unitPrice: Number(unitPrice), unitCost: unitCost === "" ? null : Number(unitCost), countsAsManagedDevice: pricingModel === "per_device" && managedDevice, invoiceSchedule: differentCycle && ownCycle ? "own" : "contract", reductionPolicy: "next_period", quantityRule: synced ? "synced" : "fixed" },
                });
                if (!r.ok) return setError(r.error);
                toast(`${description} added to ${r.data.contractName}; ${row.name} is charged on it`);
                onDone();
                router.refresh();
              })
            }
          >
            <Plus className="h-4 w-4" /> Create line and charge
          </Button>
        </span>
      </div>
    </div>
  );
}
