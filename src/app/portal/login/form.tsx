"use client";

import { useActionState } from "react";
import { Mail } from "lucide-react";
import { Field, Input, SubmitButton } from "@/components/ui/form";
import { Alert } from "@/components/ui/alert";
import { requestPortalLoginAction } from "@/actions/portal";

export function LoginRequestForm({ initialError }: { initialError?: string }) {
  const [result, formAction] = useActionState(requestPortalLoginAction, null);
  if (result?.ok)
    return (
      <Alert tone="success" title="Check your inbox">
        If that address has portal access, a sign-in link is on its way. It works once and expires in 20 minutes. Check spam if nothing arrives.
      </Alert>
    );
  return (
    <form action={formAction} className="space-y-4">
      {initialError && <Alert tone="error">{initialError}</Alert>}
      {result && !result.ok && <Alert tone="error">{result.error}</Alert>}
      <Field label="E-mail address" htmlFor="portal-email">
        <Input id="portal-email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <SubmitButton className="w-full"><Mail className="h-4 w-4" /> E-mail me a sign-in link</SubmitButton>
    </form>
  );
}
