"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { runBillingRun } from "@/services/billing-run";

export type BillingRunResult = Awaited<ReturnType<typeof runBillingRun>>;

export async function runBillingRunAction(_prev: ActionResult<BillingRunResult> | null, fd: FormData): Promise<ActionResult<BillingRunResult>> {
  return runAction(async () => {
    const u = await requireActionPermission("invoice.prepare");
    const asOf = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Run date is required").parse(fd.get("asOf"));
    const contractIds = z.array(z.uuid()).min(1, "Tick at least one contract").parse(fd.getAll("contractIds[]").map(String));
    const result = await runBillingRun(asOf, contractIds, u.id, { consolidate: fd.get("consolidate") === "true" });
    revalidatePath("/billing", "layout");
    revalidatePath("/contracts", "layout");
    return result;
  });
}
