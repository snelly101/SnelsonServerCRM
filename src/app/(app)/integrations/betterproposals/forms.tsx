"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Checkbox, Field, Input, Select, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
import { connectBetterProposalsAction, saveIntegrationConfigAction } from "@/actions/integrations";

export function ConnectForm() {
  const [result, formAction] = useActionState(connectBetterProposalsAction, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      ref.current?.reset();
      router.refresh();
    }
  }, [result, router]);
  return (
    <form ref={ref} action={formAction} className="space-y-3">
      {result?.ok ? (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" role="status">
          Connected to {result.data.accountName}.
        </p>
      ) : (
        <FormMessage result={result} />
      )}
      <Field label="API token" htmlFor="bp-token" required error={fieldErrors(result, "_")}>
        <Input id="bp-token" name="apiToken" type="password" autoComplete="off" required placeholder="Paste the token" />
      </Field>
      <SubmitButton size="sm">Verify and save</SubmitButton>
    </form>
  );
}

export function ConfigForm({ templates, defaultTemplateId, autoCreateCompanies, readOnly }: { templates: { id: string; name: string; isDefault: boolean }[]; defaultTemplateId: string; autoCreateCompanies: boolean; readOnly: boolean }) {
  const [result, formAction] = useActionState(saveIntegrationConfigAction.bind(null, "betterproposals"), null);
  return (
    <form action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <Field label="Default template for new proposals" htmlFor="bp-template" help="Can be changed per proposal.">
        <Select id="bp-template" name="defaultTemplateId" defaultValue={defaultTemplateId} disabled={readOnly}>
          <option value="">— choose —</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isDefault ? " (BP default)" : ""}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset disabled={readOnly} className="space-y-1">
        {/* The hidden field comes first so a ticked box's "true" wins when both are posted. */}
        <input type="hidden" name="autoCreateCompanies" value="false" />
        <Checkbox name="autoCreateCompanies" value="true" defaultChecked={autoCreateCompanies} label="Create a Better Proposals company automatically for every new CRM company" />
        <p className="text-xs text-slate-500">
          Runs when a company is created (any status, since prospects receive proposals) and again when an older company becomes a customer. A Better Proposals company with the same name is linked instead of duplicated. Contacts cannot be pushed on their own: the API has no contact endpoint, so they are sent as recipients when a proposal is created.
        </p>
      </fieldset>
      {!readOnly && <SubmitButton size="sm">Save defaults</SubmitButton>}
    </form>
  );
}
