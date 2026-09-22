import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { completeXeroConnect } from "@/services/xero";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/** OAuth callback. Stores tokens and sends the admin to choose the organisation. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !can(user.role, "integration.manage")) return NextResponse.redirect(new URL("/forbidden", req.url));
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error || !code || !state) {
    return NextResponse.redirect(new URL(`/integrations/xero?error=${encodeURIComponent(error ?? "Xero did not return an authorisation code")}`, req.url));
  }
  try {
    const res = await completeXeroConnect(code, state);
    await audit({ actorUserId: user.id, action: "integration.oauth.complete", entityType: "integration", entityId: "xero", details: { tenants: res.tenants.length, selected: res.selected } });
    return NextResponse.redirect(new URL(res.selected ? "/integrations/xero?connected=1" : "/integrations/xero?choose=1", req.url));
  } catch (err) {
    logger.error({ err }, "xero oauth callback failed");
    return NextResponse.redirect(new URL(`/integrations/xero?error=${encodeURIComponent(err instanceof Error ? err.message : "Connection failed")}`, req.url));
  }
}
