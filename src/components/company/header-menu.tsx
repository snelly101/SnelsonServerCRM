"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Archive, ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { archiveCompanyAction } from "@/actions/companies";

/**
 * Overflow menu for the company header. Archive / restore live here so the
 * destructive action is one step away rather than a permanent red button.
 * Uses the same confirmation flow as ConfirmButton.
 */
export function CompanyHeaderMenu({ companyId, archived, canArchive }: { companyId: string; archived: boolean; canArchive: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!canArchive) return null;
  const title = archived ? "Restore this company?" : "Archive this company?";
  const description = archived ? undefined : "It will be hidden from lists but nothing is deleted. Linked contacts, opportunities and history are kept and you can restore it later.";
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="secondary" size="sm" aria-label="More actions" className="px-2">
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-40 min-w-[180px] rounded-md border border-slate-200 bg-surface p-1 shadow-lg">
            <DropdownMenu.Item
              onSelect={() => setConfirm(true)}
              className={`flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-100 ${archived ? "text-slate-700" : "text-red-700"}`}
            >
              {archived ? <ArchiveRestore className="h-4 w-4" aria-hidden /> : <Archive className="h-4 w-4" aria-hidden />}
              {archived ? "Restore company" : "Archive company"}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog open={confirm} onOpenChange={setConfirm}>
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
              variant={archived ? "primary" : "danger"}
              loading={pending}
              onClick={() =>
                start(async () => {
                  const res = await archiveCompanyAction(companyId, archived);
                  if (res.ok) {
                    setConfirm(false);
                    router.refresh();
                  } else setError(res.error);
                })
              }
            >
              {archived ? "Restore" : "Archive"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
