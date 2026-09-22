"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/form";
import { linkProposalAction } from "@/actions/integrations";

export function LinkProposalDialog({ externalId, subject, companies, opportunities }: { externalId: string; subject: string; companies: { id: string; name: string }[]; opportunities: { id: string; title: string; companyName: string }[] }) {
  const [open, setOpen] = useState(false);
  const [opportunityId, setOpportunityId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Link2 className="h-3.5 w-3.5" /> Link
      </Button>
      <DialogContent title="Link proposal" description={subject}>
        {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="space-y-3">
          <Field label="Opportunity" htmlFor="lp-opp" help="Linking to an opportunity also links the company. If the proposal is already signed, the opportunity is marked won and onboarding starts.">
            <Select id="lp-opp" value={opportunityId} onChange={(e) => setOpportunityId(e.target.value)}>
              <option value="">—</option>
              {opportunities.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.companyName} · {o.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Or company only" htmlFor="lp-co">
            <Select id="lp-co" value={companyId} onChange={(e) => setCompanyId(e.target.value)} disabled={Boolean(opportunityId)}>
              <option value="">—</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={pending}
              disabled={!opportunityId && !companyId}
              onClick={() =>
                start(async () => {
                  const res = await linkProposalAction(externalId, opportunityId ? { opportunityId } : { companyId });
                  if (!res.ok) return setError(res.error);
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              Link
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
