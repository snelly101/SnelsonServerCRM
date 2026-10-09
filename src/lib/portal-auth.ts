import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { PORTAL_COOKIE } from "@/lib/portal-session";
import { portalAccountFromSession, type PortalAccount } from "@/services/portal";

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
