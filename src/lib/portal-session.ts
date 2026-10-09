import { createHash, randomBytes } from "node:crypto";

/**
 * Customer portal session plumbing: a separate cookie from the staff
 * session, random tokens stored only as hashes. Nothing here touches the
 * database; src/services/portal.ts owns the rows.
 */
export const PORTAL_COOKIE = "crm_portal";
export const PORTAL_SESSION_DAYS = 30;
export const PORTAL_LOGIN_TOKEN_MINUTES = 20;
export const PORTAL_INVITE_TOKEN_HOURS = 72;

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function portalCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** Absolute portal URL for links in e-mail. */
export function portalUrl(path: string) {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
