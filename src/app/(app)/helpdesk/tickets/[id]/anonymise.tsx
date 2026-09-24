"use client";

import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { anonymiseTicketAction } from "@/actions/helpdesk-kb";

/** Admin-only: strips the requester's identity and attachments now instead of waiting for retention. */
export function AnonymiseButton({ ticketId, reference }: { ticketId: string; reference: string }) {
  const router = useRouter();
  return (
    <ConfirmButton
      variant="secondary"
      action={async () => {
        const r = await anonymiseTicketAction(ticketId);
        router.refresh();
        return r;
      }}
      title={`Anonymise ${reference}?`}
      description="Removes the requester's name, e-mail, contact link, all participants, message addresses and attachments. The conversation text, events and time entries stay. This cannot be undone."
      confirmLabel="Anonymise"
    >
      Anonymise
    </ConfirmButton>
  );
}
