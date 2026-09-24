"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { parseThemePref, THEME_COOKIE, type ThemePref } from "@/lib/theme";
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

/** Saves the theme on the user record and in the cookie the root layout reads before first paint. */
export async function setThemeAction(pref: ThemePref): Promise<ActionResult<{ theme: ThemePref }>> {
  return runAction(async () => {
    const u = await requireActionPermission("company.read");
    const theme = parseThemePref(pref);
    await db.update(user).set({ theme, updatedAt: new Date() }).where(eq(user.id, u.id));
    (await cookies()).set(THEME_COOKIE, theme, { path: "/", maxAge: 365 * 24 * 3600, sameSite: "lax" });
    return { theme };
  });
}
