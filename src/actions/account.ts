"use server";

import { revalidatePath } from "next/cache";
import { requireActionPermission } from "@/lib/session";
import { runAction, type ActionResult } from "@/lib/action-result";
import { audit } from "@/lib/audit";
import { revokeTrustedDevices } from "@/services/users";

/** Forgets every browser the signed-in user trusted for 30 days. */
export async function revokeMyTrustedDevicesAction(): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.read");
    const count = await revokeTrustedDevices(u.id, u.id);
    revalidatePath("/account/security");
    return { count };
  });
}

/** Writes an audit row for enrolment events the browser completed directly against the auth API. */
export async function recordTwoFactorEventAction(event: "enabled" | "disabled" | "backup_codes_regenerated"): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.read");
    await audit({ actorUserId: u.id, action: `user.two_factor.${event}`, entityType: "user", entityId: u.id });
    revalidatePath("/", "layout");
    return undefined;
  });
}
