"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, type ButtonProps } from "./button";
import { Dialog, DialogContent, DialogClose } from "./dialog";
import type { ActionResult } from "@/lib/action-result";
import { useToast } from "./toast";

/**
 * A button that asks for confirmation, then runs a server action and shows
 * any error inline. Used for archive/delete style actions.
 *
 * On success a toast confirms what happened (`successMessage`, default "Done")
 * and the page refreshes, or navigates to `successHref` when the thing just
 * acted on no longer belongs on the current page (for example an archived
 * record that is about to vanish from the list it came from).
 */
export function ConfirmButton({
  action,
  title,
  description,
  confirmLabel = "Confirm",
  successMessage = "Done",
  successHref,
  children,
  ...props
}: ButtonProps & {
  action: () => Promise<ActionResult<unknown>>;
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Toast shown after the action succeeds. Pass null to show none. */
  successMessage?: string | null;
  /** Where to go after success; defaults to refreshing the current page. */
  successHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button {...props} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <DialogContent title={title} description={description}>
        {error && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button
            variant={props.variant === "danger-outline" || props.variant === "danger" ? "danger" : "primary"}
            loading={pending}
            onClick={() =>
              start(async () => {
                const res = await action();
                if (res.ok) {
                  setOpen(false);
                  if (successMessage) toast(successMessage);
                  if (successHref) router.push(successHref);
                  else router.refresh();
                } else setError(res.error);
              })
            }
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
