"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, Checkbox, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { saveSiteAction } from "@/actions/companies";

type Site = {
  id: string;
  name: string;
  isPrimary: boolean;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  notes: string | null;
};

export function SiteDialog({ companyId, site }: { companyId: string; site?: Site }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [result, formAction] = useActionState(saveSiteAction.bind(null, site?.id ?? null), null);
  const e = (k: string) => fieldErrors(result, k);

  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant={site ? "ghost" : "primary"} size="sm" onClick={() => setOpen(true)}>
        {site ? "Edit" : (<><Plus className="h-4 w-4" /> Add site</>)}
      </Button>
      <DialogContent title={site ? `Edit ${site.name}` : "Add site"}>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="companyId" value={companyId} />
          <FormMessage result={result && !result.ok ? result : null} />
          <Field label="Site name" htmlFor="site-name" required error={e("name")}>
            <Input id="site-name" name="name" required defaultValue={site?.name ?? ""} placeholder="Head office" />
          </Field>
          <Checkbox name="isPrimary" label="Primary site" defaultChecked={site?.isPrimary} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Address line 1" htmlFor="site-a1" className="sm:col-span-2">
              <Input id="site-a1" name="addressLine1" defaultValue={site?.addressLine1 ?? ""} />
            </Field>
            <Field label="Address line 2" htmlFor="site-a2" className="sm:col-span-2">
              <Input id="site-a2" name="addressLine2" defaultValue={site?.addressLine2 ?? ""} />
            </Field>
            <Field label="Town / city" htmlFor="site-city">
              <Input id="site-city" name="city" defaultValue={site?.city ?? ""} />
            </Field>
            <Field label="County / region" htmlFor="site-region">
              <Input id="site-region" name="region" defaultValue={site?.region ?? ""} />
            </Field>
            <Field label="Postcode" htmlFor="site-postcode">
              <Input id="site-postcode" name="postcode" defaultValue={site?.postcode ?? ""} />
            </Field>
            <Field label="Country" htmlFor="site-country">
              <Input id="site-country" name="country" defaultValue={site?.country ?? "GB"} maxLength={2} />
            </Field>
            <Field label="Phone" htmlFor="site-phone">
              <Input id="site-phone" name="phone" defaultValue={site?.phone ?? ""} />
            </Field>
          </div>
          <Field label="Notes" htmlFor="site-notes">
            <Textarea id="site-notes" name="notes" defaultValue={site?.notes ?? ""} rows={2} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save site</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
