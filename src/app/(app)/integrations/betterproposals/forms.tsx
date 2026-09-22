"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Select, SubmitButton, FormMessage, fieldErrors } from "@/components/ui/form";
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

export function ConfigForm({ templates, defaultTemplateId, readOnly }: { templates: { id: string; name: string; isDefault: boolean }[]; defaultTemplateId: string; readOnly: boolean }) {
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
      {!readOnly && <SubmitButton size="sm">Save defaults</SubmitButton>}
    </form>
  );
}
