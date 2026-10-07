"use client";

import { useRouter } from "next/navigation";
import { FilePlus2 } from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { contractFromProposalAction } from "@/actions/integrations";
import { useToast } from "@/components/ui/toast";

/** Creates (or opens) the contract for a signed proposal, then goes to it. */
export function ContractFromProposalButton({ externalId, linked }: { externalId: string; linked: boolean }) {
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      title="Create a contract from this signed proposal?"
      description={linked ? "The linked opportunity is marked won, onboarding starts and a draft contract is created from its lines with the signed terms captured. Nothing is invoiced until the contract is activated." : "No opportunity is linked, so a draft contract is created from the proposal's totals (one line per billing term) for you to replace with the agreed services. Nothing is invoiced until it is activated."}
      confirmLabel="Create contract"
      successMessage={null}
      action={async () => {
        const r = await contractFromProposalAction(externalId);
        if (r.ok) {
          toast(r.data.created ? "Draft contract created from the proposal" : "This proposal already has a contract");
          router.push(`/contracts/${r.data.contractId}${r.data.created && !linked ? "/edit" : ""}`);
        }
        return r;
      }}
    >
      <FilePlus2 className="h-3.5 w-3.5" /> Create contract
    </ConfirmButton>
  );
}
