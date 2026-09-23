"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { connectTwentyI, linkHostingItem, saveTwentyIConfig, setHostingBillingLine, syncTwentyI, testTwentyI, unlinkHostingItem } from "@/services/twentyi";

const revalidate = () => {
  revalidatePath("/integrations", "layout");
  revalidatePath("/companies", "layout");
};

export async function connectTwentyIAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ packageCount: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const input = z.object({ apiKey: z.string().trim().min(16, "That does not look like a 20i API key").max(500) }).parse({ apiKey: fd.get("apiKey") });
    const t = await connectTwentyI(input, u.id);
    revalidate();
    return { packageCount: t.ok ? t.packageCount : 0 };
  });
}

export async function testTwentyIAction(): Promise<ActionResult<{ ok: boolean; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const t = await testTwentyI(u.id);
    revalidate();
    return { ok: t.ok, message: t.ok ? `Connected to reseller ${t.resellerId} (${t.packageCount} packages)` : t.error };
  });
}

export async function syncTwentyIAction(): Promise<ActionResult<{ status: string; message: string }>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.sync");
    const res = await syncTwentyI("manual", u.id);
    revalidate();
    if (!res) return { status: "skipped", message: "20i is not configured." };
    return { status: res.status, message: res.status === "failed" ? (res.message ?? "Sync failed") : `${res.counters.fetched} items checked, ${res.counters.created} new, ${res.counters.updated} updated${res.counters.errors ? `, ${res.counters.errors} errors` : ""}` };
  });
}

export async function linkHostingItemAction(itemId: string, companyId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await linkHostingItem(z.uuid().parse(itemId), z.uuid().parse(companyId), u.id);
    revalidate();
    return undefined;
  });
}

export async function unlinkHostingItemAction(itemId: string): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    await unlinkHostingItem(z.uuid().parse(itemId), u.id);
    revalidate();
    return undefined;
  });
}

export async function setHostingBillingLineAction(itemId: string, contractLineId: string | null): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("contract.write");
    await setHostingBillingLine(z.uuid().parse(itemId), contractLineId ? z.uuid().parse(contractLineId) : null, u.id);
    revalidate();
    return undefined;
  });
}

export async function saveTwentyIConfigAction(_prev: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("integration.manage");
    const input = z
      .object({ expiryReminderDays: z.coerce.number().int().min(1).max(365), autoLink: z.boolean(), syncMailboxes: z.boolean() })
      .parse({ expiryReminderDays: fd.get("expiryReminderDays"), autoLink: fd.get("autoLink") === "true", syncMailboxes: fd.get("syncMailboxes") === "true" });
    await saveTwentyIConfig(input, u.id);
    revalidate();
    return undefined;
  });
}
