import { appUrl } from "@/lib/app-url";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Fast redirect for signed-out visitors. This only checks that a session
 * cookie exists; every page and action still verifies the session and role
 * against the database.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/api/auth") || pathname.startsWith("/api/webhooks") || pathname === "/api/health";
  const hasSession = Boolean(getSessionCookie(req));
  if (!isPublic && !hasSession) {
    const url = appUrl("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname === "/login" && hasSession) {
    return NextResponse.redirect(appUrl("/", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|jpg|css|js)).*)"],
};
