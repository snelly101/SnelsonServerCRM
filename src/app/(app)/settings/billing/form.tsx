"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, SubmitButton, FormMessage, Checkbox } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { runBillingAutomationAction, updateBillingAutomationAction } from "@/actions/admin";
import type { AutomationRunResult } from "@/services/billing-automation";

export function BillingAutomationForm({ levels, settings, readOnly }: { levels: { level: number; label: string; detail: string }[]; settings: { billingAutomationLevel: number; billingAutomationDay: number; billingAutomationConsolidate: boolean }; readOnly: boolean }) {
  const [result, formAction] = useActionState(updateBillingAutomationAction, null);
  const [consolidate, setConsolidate] = useState(settings.billingAutomationConsolidate);
  return (
    <form action={formAction} className="space-y-4">
      <FormMessage result={result} />
      <input type="hidden" name="billingAutomationConsolidate" value={consolidate ? "true" : "false"} />
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Automation level</p>
          {levels.map((l) => (
            <label key={l.level} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="billingAutomationLevel" value={l.level} defaultChecked={settings.billingAutomationLevel === l.level} className="mt-1" />
              <span>
                <span className="font-medium">{l.level}. {l.label}</span>
                <span className="block text-xs text-slate-500">{l.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Run day of the month" htmlFor="billingAutomationDay" help="The scheduled run happens once a month, on the first daily check on or after this day (07:00). Contracts anchored to later days are picked up on the next month's run if they are not due yet.">
          <Input id="billingAutomationDay" name="billingAutomationDay" type="number" min={1} max={28} defaultValue={settings.billingAutomationDay} className="w-32" required />
        </Field>
        <Checkbox label="One draft per customer where several agreements are due" checked={consolidate} onChange={(e) => setConsolidate(e.target.checked)} />
      </fieldset>
      {!readOnly && <SubmitButton>Save policy</SubmitButton>}
      {readOnly && <p className="text-xs text-slate-500">Only administrators can change the policy.</p>}
    </form>
  );
}

export function RunNowButton() {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<AutomationRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="secondary"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await runBillingAutomationAction();
            if (!r.ok) return setError(r.error);
            setError(null);
            setRes(r.data);
            router.refresh();
          })
        }
      >
        Run the policy now
      </Button>
      {error && <Alert tone="error">{error}</Alert>}
      {res && (
        <Alert tone={res.level === 0 ? "info" : "success"} title={res.level === 0 ? `Detect only: ${res.readyContracts} ready, ${res.reviewContracts} need review, ${res.blockedContracts} blocked; nothing created` : `${res.prepared.length} draft${res.prepared.length === 1 ? "" : "s"} prepared${res.level >= 2 ? `, ${res.approved.length} created in Xero, ${res.approvalSkipped.length} left for review` : ""}`}>
          {res.prepared.length > 0 && (
            <ul className="list-disc pl-5 text-xs">
              {res.prepared.map((p) => (
                <li key={p.draftId}>
                  <Link href={`/billing/drafts/${p.draftId}`} className="underline">{p.companyName} · {p.contractName}</Link>
                </li>
              ))}
            </ul>
          )}
          {res.approvalSkipped.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {res.approvalSkipped.map((s) => (
                <li key={s.id}>{s.reference} ({s.companyName}): {s.reason}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs">Audited as a billing automation run naming the policy. <Link href="/billing" className="underline">Open Finance</Link>.</p>
        </Alert>
      )}
    </div>
  );
}
