import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, type ServiceSource } from "@/db/schema";
import { ActionError } from "@/lib/action-result";
import { contractSchema, type ContractLineInput } from "@/lib/validation-sales";
import { addContractLine, createContract } from "./contracts";
import { serviceSourceRow, setServiceLink } from "./service-links";
import { PROVIDER_OF_SOURCE } from "./billing-adapters";

/**
 * Matching an integration's service to a charge when no suitable line
 * exists yet: create the line (on one of the customer's agreements, or on a
 * new draft agreement) and charge the service on it in one step. The line
 * goes through the same validation and history as the contract form, the
 * link through the same rules as any other, and the provider's quantity
 * check runs afterwards so the new line reads "in step" straight away.
 */
export type CreateLineForService = {
  source: ServiceSource;
  sourceRowId: string;
  /** The line as the form validates it (the action parses it with `contractLineSchema`). Put it on this agreement... */
  contractId?: string | null;
  /** ...or on a new draft agreement for the customer. */
  newContract?: { name: string; startDate: string; billingFrequency: "monthly" | "quarterly" | "annual" } | null;
  line: Omit<ContractLineInput, "id">;
};

export async function createLineForService(input: CreateLineForService, actorUserId: string) {
  const row = await serviceSourceRow(input.source, input.sourceRowId);
  if (!row?.companyId) throw new ActionError("That service is not linked to a company; link it first.");
  const companyId = row.companyId;
  let contractId = input.contractId || null;
  if (!contractId) {
    if (!input.newContract) throw new ActionError("Choose the agreement the line goes on, or create a new one.");
    contractId = await createContract(contractSchema.parse({ companyId, name: input.newContract.name, startDate: input.newContract.startDate, status: "draft", billingFrequency: input.newContract.billingFrequency }), [], actorUserId);
  } else {
    const [c] = await db.select({ companyId: contracts.companyId }).from(contracts).where(eq(contracts.id, contractId)).limit(1);
    if (!c) throw new ActionError("Contract not found.");
    if (c.companyId !== companyId) throw new ActionError("That contract belongs to a different company.");
  }
  const line: ContractLineInput = { ...input.line, id: null };
  const provider = PROVIDER_OF_SOURCE[input.source];
  const added = await addContractLine(contractId, line, actorUserId, `Added to charge ${row.name} (${provider})`);
  await setServiceLink({ source: input.source, sourceRowId: input.sourceRowId, role: "charged", contractLineId: added.lineId }, actorUserId);
  if (provider !== "ninjaone") {
    const { runQuantityChecks } = await import("./quantity-check");
    await runQuantityChecks(actorUserId, { companyId, providers: [provider] });
  }
  return { companyId, contractId, contractLineId: added.lineId, contractName: added.contractName };
}
