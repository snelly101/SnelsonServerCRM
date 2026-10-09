"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action-result";
import { PORTAL_COOKIE } from "@/lib/portal-session";
import { portalRequestContext, requirePortalAccount } from "@/lib/portal-auth";
import { beginPortalTotpSetup, confirmPortalTotpSetup, portalSubmitFeedback, requestPortalLogin, signOutPortal, verifyPortalSecondFactor } from "@/services/portal";

export async function requestPortalLoginAction(_prev: ActionResult<{ sent: true }> | null, fd: FormData): Promise<ActionResult<{ sent: true }>> {
  return runAction(async () => {
    const email = z.string().trim().email("Enter your e-mail address").max(200).parse(fd.get("email"));
    const ctx = await portalRequestContext();
    await requestPortalLogin(email, ctx);
    // Always the same answer, whether or not the address is known.
    return { sent: true as const };
  });
}

export async function portalSignOutAction() {
  const store = await cookies();
  await signOutPortal(store.get(PORTAL_COOKIE)?.value);
  store.delete(PORTAL_COOKIE);
  redirect("/portal/login");
}

export async function portalFeedbackAction(ticketId: string, _prev: ActionResult<undefined> | null, fd: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const account = await requirePortalAccount();
    const rating = z.coerce.number().int().min(1).max(5).parse(fd.get("rating"));
    const comment = z.string().max(2000).optional().parse(fd.get("comment") ?? undefined) ?? null;
    await portalSubmitFeedback(account, z.uuid().parse(ticketId), rating, comment);
    return undefined;
  });
}

export async function portalTotpSetupBeginAction(): Promise<ActionResult<{ secret: string; uri: string; issuer: string }>> {
  return runAction(async () => beginPortalTotpSetup((await cookies()).get(PORTAL_COOKIE)?.value));
}

export async function portalTotpSetupConfirmAction(code: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(async () => {
    const ctx = await portalRequestContext();
    return confirmPortalTotpSetup((await cookies()).get(PORTAL_COOKIE)?.value, z.string().min(6).max(12).parse(code), ctx);
  });
}

export async function portalVerifyCodeAction(code: string): Promise<ActionResult<{ factor: "totp" | "recovery"; recoveryCodesLeft: number } | { setupRequired: true }>> {
  return runAction(async () => {
    const ctx = await portalRequestContext();
    try {
      return await verifyPortalSecondFactor((await cookies()).get(PORTAL_COOKIE)?.value, z.string().min(6).max(20).parse(code), ctx);
    } catch (err) {
      if (err instanceof Error && err.message === "SETUP_REQUIRED") return { setupRequired: true as const };
      throw err;
    }
  });
}
