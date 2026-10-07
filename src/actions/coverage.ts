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

/** Charges a supplied service on a contract line (or clears the link), then re-runs the provider's quantity check. */
export async function setServiceLineAction(source: string, sourceRowId: string, contractLineId: string | null): Promise<ActionResult<{ companyId: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    const src = z.enum(coverageSourceValues).parse(source);
    const rowId = z.uuid().parse(sourceRowId);
    const { setServiceLink, clearServiceLink } = await import("@/services/service-links");
    let companyId: string | null = null;
    if (contractLineId) companyId = (await setServiceLink({ source: src, sourceRowId: rowId, role: "charged", contractLineId: z.uuid().parse(contractLineId) }, u.id)).companyId;
    else companyId = (await clearServiceLink(src, rowId, u.id))?.companyId ?? null;
    if (companyId && src !== "ninja_device") {
      const { runQuantityChecks } = await import("@/services/quantity-check");
      await runQuantityChecks(u.id, { companyId, providers: [src === "pax8_subscription" ? "pax8" : "twentyi"] });
    }
    revalidate(companyId ?? undefined);
    revalidatePath("/contracts", "layout");
    return { companyId: companyId ?? "" };
  });
}
