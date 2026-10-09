import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { PORTAL_COOKIE } from "@/lib/portal-session";
import { pendingPortalSession, portalAccountFromSession, type PortalAccount } from "@/services/portal";

/** The signed-in customer for a portal page or route, or null. */
export async function currentPortalAccount(): Promise<PortalAccount | null> {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  return portalAccountFromSession(token);
}

export async function requirePortalAccount(next?: string): Promise<PortalAccount> {
  const a = await currentPortalAccount();
  if (!a) redirect(`/portal/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  return a;
}

export async function portalRequestContext() {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return { ip: (forwarded ? forwarded.split(",")[0] : h.get("x-real-ip"))?.trim() || null, userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}

/** The customer who has redeemed a link but not yet passed the authenticator step; sends them to sign in when there is none. */
export async function requirePendingPortalSession() {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  if (await portalAccountFromSession(token)) redirect("/portal");
  const pending = await pendingPortalSession(token);
  if (!pending) redirect("/portal/login?error=" + encodeURIComponent("Your sign-in has expired. Request a new link."));
  return pending;
}
