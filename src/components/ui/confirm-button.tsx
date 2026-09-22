"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, type ButtonProps } from "./button";
import { Dialog, DialogContent, DialogClose } from "./dialog";
import type { ActionResult } from "@/lib/action-result";

/**
 * A button that asks for confirmation, then runs a server action and shows
 * any error inline. Used for archive/delete style actions.
 */
export function ConfirmButton({
  action,
  title,
  description,
  confirmLabel = "Confirm",
  children,
  ...props
}: ButtonProps & {
  action: () => Promise<ActionResult<unknown>>;
  title: string;
  description?: string;
  confirmLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
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
                  router.refresh();
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
