import { NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { startXeroConnect } from "@/services/xero";

/** Starts the Xero OAuth flow (admin only). Redirects to Xero's consent screen. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "integration.manage")) return NextResponse.redirect(appUrl("/forbidden", req.url));
  try {
    const url = await startXeroConnect(user.id);
    return NextResponse.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not start the Xero connection";
    return NextResponse.redirect(appUrl(`/integrations/xero?error=${encodeURIComponent(msg)}`, req.url));
  }
}
