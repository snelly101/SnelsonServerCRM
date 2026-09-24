"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Input, Select, SubmitButton, FormMessage, fieldErrors, Checkbox } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createUserAction, resetTwoFactorAction, updateUserAction } from "@/actions/admin";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/permissions";

export function CreateUserForm() {
  const [result, formAction] = useActionState(createUserAction, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      ref.current?.reset();
      router.refresh();
    }
  }, [result, router]);
  const e = (k: string) => fieldErrors(result, k);
  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <FormMessage result={result} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="u-name" required error={e("name")}>
          <Input id="u-name" name="name" required />
        </Field>
        <Field label="Email" htmlFor="u-email" required error={e("email")}>
          <Input id="u-email" name="email" type="email" required autoComplete="off" />
        </Field>
        <Field label="Role" htmlFor="u-role" required error={e("role")}>
          <Select id="u-role" name="role" defaultValue="read_only">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Temporary password" htmlFor="u-password" required error={e("password")} help="At least 10 characters. Share it securely and ask them to change it.">
          <Input id="u-password" name="password" type="password" required minLength={10} autoComplete="new-password" />
        </Field>
      </div>
      <SubmitButton>Create account</SubmitButton>
    </form>
  );
}

export function EditUserDialog({ user }: { user: { id: string; name: string; email: string; role: Role; active: boolean } }) {
  const [open, setOpen] = useState(false);
  const [result, formAction] = useActionState(updateUserAction, null);
  const router = useRouter();
  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);
  const e = (k: string) => fieldErrors(result, k);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <DialogContent title={`Edit ${user.name}`} description={user.email}>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="id" value={user.id} />
          <FormMessage result={result && !result.ok ? result : null} />
          <Field label="Name" htmlFor="eu-name" required error={e("name")}>
            <Input id="eu-name" name="name" defaultValue={user.name} required />
          </Field>
          <Field label="Role" htmlFor="eu-role" error={e("role")}>
            <Select id="eu-role" name="role" defaultValue={user.role}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="New password" htmlFor="eu-password" error={e("password")} help="Leave blank to keep the current password.">
            <Input id="eu-password" name="password" type="password" minLength={10} autoComplete="new-password" />
          </Field>
          <Checkbox name="active" label="Account enabled" defaultChecked={user.active} />
          <div className="flex justify-end gap-2 pt-2">
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

/** Lost phone and no recovery codes: an administrator removes the second factor so the user can enrol again. */
export function ResetTwoFactorButton({ userId, name }: { userId: string; name: string }) {
  return (
    <ConfirmButton variant="ghost" size="sm" action={resetTwoFactorAction.bind(null, userId)} title={`Reset two-factor authentication for ${name}?`} description="Their authenticator app and recovery codes stop working, trusted browsers are forgotten and they are signed out everywhere. They can set it up again from their Security page. This is recorded in the audit log." confirmLabel="Reset">
      Reset 2FA
    </ConfirmButton>
  );
}
