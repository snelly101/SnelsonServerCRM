"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Checkbox, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { saveProductAction } from "@/actions/sales";
import { CATEGORY_LABELS, FREQUENCY_LABELS, PRICING_LABELS, REVENUE_LABELS, billingFrequencyValues, pricingModelValues, productCategoryValues, revenueTypeValues } from "@/lib/validation-sales";

type Product = {
  id: string;
  sku: string | null;
  name: string;
  category: string;
  description: string | null;
  pricingModel: string;
  revenueType: string;
  billingFrequency: string;
  unitPrice: number;
  unitCost: number | null;
  countsAsManagedDevice: boolean;
  active: boolean;
};

export function ProductDialog({ product }: { product?: Product }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(saveProductAction.bind(null, product?.id ?? null), null);
  const [pricing, setPricing] = useState(product?.pricingModel ?? "per_user");
  const [revenue, setRevenue] = useState(product?.revenueType ?? "recurring");
  const [device, setDevice] = useState(product?.countsAsManagedDevice ?? false);
  const [active, setActive] = useState(product?.active ?? true);
  const e = (k: string) => fieldErrors(result, k);
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size={product ? "sm" : "md"} variant={product ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {product ? "Edit" : (<><Plus className="h-4 w-4" /> Add product</>)}
      </Button>
      <DialogContent title={product ? `Edit ${product.name}` : "New product or service"}>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="countsAsManagedDevice" value={device ? "true" : "false"} />
          <input type="hidden" name="active" value={active ? "true" : "false"} />
          <FormMessage result={result && !result.ok ? result : null} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="p-name" required error={e("name")} className="sm:col-span-2">
              <Input id="p-name" name="name" required defaultValue={product?.name ?? ""} />
            </Field>
            <Field label="SKU" htmlFor="p-sku" error={e("sku")}>
              <Input id="p-sku" name="sku" defaultValue={product?.sku ?? ""} />
            </Field>
            <Field label="Category" htmlFor="p-category">
              <Select id="p-category" name="category" defaultValue={product?.category ?? "managed_it"}>
                {productCategoryValues.map((v) => (
                  <option key={v} value={v}>
                    {CATEGORY_LABELS[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Revenue type" htmlFor="p-revenue">
              <Select id="p-revenue" name="revenueType" value={revenue} onChange={(ev) => setRevenue(ev.target.value)}>
                {revenueTypeValues.map((v) => (
                  <option key={v} value={v}>
                    {REVENUE_LABELS[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pricing model" htmlFor="p-pricing">
              <Select id="p-pricing" name="pricingModel" value={pricing} onChange={(ev) => setPricing(ev.target.value)}>
                {pricingModelValues.map((v) => (
                  <option key={v} value={v}>
                    {PRICING_LABELS[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Billing frequency" htmlFor="p-freq">
              <Select id="p-freq" name="billingFrequency" defaultValue={product?.billingFrequency ?? "monthly"} disabled={revenue !== "recurring"}>
                {billingFrequencyValues.map((v) => (
                  <option key={v} value={v}>
                    {FREQUENCY_LABELS[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unit price" htmlFor="p-price" required error={e("unitPrice")}>
              <Input id="p-price" name="unitPrice" type="number" min={0} step="0.01" required defaultValue={product?.unitPrice ?? 0} />
            </Field>
            <Field label="Unit cost" htmlFor="p-cost" error={e("unitCost")} help="Leave blank if unknown; margins will be labelled estimates">
              <Input id="p-cost" name="unitCost" type="number" min={0} step="0.01" defaultValue={product?.unitCost ?? ""} />
            </Field>
          </div>
          <Field label="Description" htmlFor="p-desc">
            <Textarea id="p-desc" name="description" rows={2} defaultValue={product?.description ?? ""} />
          </Field>
          {pricing === "per_device" && <Checkbox label="Compare contracted quantity with NinjaOne managed device count" checked={device} onChange={(ev) => setDevice(ev.target.checked)} />}
          {product && <Checkbox label="Active (available to add to new opportunities and contracts)" checked={active} onChange={(ev) => setActive(ev.target.checked)} />}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
