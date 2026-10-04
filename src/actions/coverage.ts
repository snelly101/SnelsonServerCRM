"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { coverageSourceValues, coverageStateValues } from "@/db/schema";
import { clearServiceCoverage, setServiceCoverage } from "@/services/service-register";

const revalidate = (companyId?: string) => {
  revalidatePath("/billing", "layout");
  revalidatePath("/integrations", "layout");
  if (companyId) revalidatePath(`/companies/${companyId}`);
};

export async function setServiceCoverageAction(input: { source: string; sourceRowId: string; state: string; contractLineId?: string | null; reason?: string | null; reviewOn?: string | null }): Promise<ActionResult<{ companyId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const p = z
      .object({
        source: z.enum(coverageSourceValues),
        sourceRowId: z.uuid(),
        state: z.enum(coverageStateValues),
        contractLineId: z.uuid().optional().nullable(),
        reason: z.string().trim().max(500).optional().nullable(),
        reviewOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      })
      .parse({ ...input, contractLineId: input.contractLineId || null, reviewOn: input.reviewOn || null });
    const r = await setServiceCoverage(p, u.id);
    revalidate(r.companyId);
    return r;
  });
}

export async function clearServiceCoverageAction(source: string, sourceRowId: string, companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await clearServiceCoverage(z.enum(coverageSourceValues).parse(source), z.uuid().parse(sourceRowId), u.id);
    revalidate(z.uuid().parse(companyId));
    return undefined;
  });
}
