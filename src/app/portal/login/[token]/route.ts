import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { appUrl } from "@/lib/app-url";
import { ActionError } from "@/lib/action-result";
import { PORTAL_COOKIE, portalCookieOptions } from "@/lib/portal-session";
import { portalRequestContext } from "@/lib/portal-auth";
import { redeemPortalToken } from "@/services/portal";

export const dynamic = "force-dynamic";

/** The magic link lands here: swap the one-time token for a session cookie and go to the portal. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    const { sessionToken, expiresAt } = await redeemPortalToken(token, await portalRequestContext());
    (await cookies()).set(PORTAL_COOKIE, sessionToken, portalCookieOptions(expiresAt));
    return NextResponse.redirect(appUrl("/portal", _req.url));
  } catch (err) {
    const url = appUrl("/portal/login", _req.url);
    url.searchParams.set("error", err instanceof ActionError ? err.message : "That sign-in link did not work. Request a new one.");
    return NextResponse.redirect(url);
  }
}
