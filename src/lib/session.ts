import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { getAppSettings } from "./settings";
import { assertCan, can, type Action, type Role } from "./permissions";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  twoFactorEnabled: boolean;
  /** Has a CRM password (credential account). SSO-only users get MFA from Entra and are exempt from the policy. */
  hasPassword: boolean;
};

export type TwoFactorPolicy = {
  required: boolean;
  enabled: boolean;
  deadline: string | null;
  /** Required, not enrolled, and past the deadline (or no deadline): pages redirect to enrolment. */
  mustEnrol: boolean;
  /** Required, not enrolled, deadline still ahead: show a reminder banner. */
  dueBy: string | null;
};

/** Applies the Settings → Security policy to one user. Pure, so it is unit-testable. */
export function twoFactorPolicy(u: Pick<CurrentUser, "role" | "twoFactorEnabled" | "hasPassword">, settings: { twoFactorRequiredRoles: string[]; twoFactorDeadline: string | null }, today = new Date().toISOString().slice(0, 10)): TwoFactorPolicy {
  const required = settings.twoFactorRequiredRoles.includes(u.role) && u.hasPassword;
  const outstanding = required && !u.twoFactorEnabled;
  const deadline = settings.twoFactorDeadline;
  const pastDeadline = !deadline || deadline < today;
  return { required, enabled: u.twoFactorEnabled, deadline, mustEnrol: outstanding && pastDeadline, dueBy: outstanding && !pastDeadline ? deadline : null };
}

/**
 * Returns the signed-in user with their role read fresh from the database.
 * Cached per request so layouts, pages and actions share one lookup.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const [row] = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      role: userTable.role,
      active: userTable.active,
      twoFactorEnabled: userTable.twoFactorEnabled,
      // Literal SQL: Drizzle renders column references unqualified inside a select-field subquery.
      hasPassword: sql<boolean>`exists (select 1 from account a where a.user_id = "user".id and a.provider_id = 'credential' and a.password is not null)`,
    })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  if (!row || !row.active) return null;
  return { ...row, hasPassword: Boolean(row.hasPassword) };
});

/** The signed-in user's two-factor status against the current policy. */
export const currentTwoFactorPolicy = cache(async (): Promise<TwoFactorPolicy | null> => {
  const u = await getCurrentUser();
  if (!u) return null;
  const settings = await getAppSettings();
  return twoFactorPolicy(u, settings);
});

const ENROL_PATH = "/account/security";

/**
 * For pages: redirects to /login when signed out. When the security policy
 * requires a second factor the user has not set up (and the deadline has
 * passed), every page except the enrolment page redirects there.
 */
export async function requireUser(opts?: { allowUnenrolled?: boolean }): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (!opts?.allowUnenrolled) {
    const policy = await currentTwoFactorPolicy();
    if (policy?.mustEnrol) redirect(`${ENROL_PATH}?required=1`);
  }
  return u;
}

/** For pages: redirects to /login when signed out and to / when forbidden. */
export async function requirePermission(action: Action): Promise<CurrentUser> {
  const u = await requireUser();
  if (!can(u.role, action)) redirect("/forbidden");
  return u;
}

/** For server actions: throws so the caller can return a readable error. */
export async function requireActionPermission(action: Action): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new Error("You are signed out. Please sign in again.");
  assertCan(u.role, action);
  return u;
}

/** Request metadata for audit trails: client IP (as forwarded by the reverse proxy), user agent and session id. */
export async function getRequestContext() {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const ipAddress = (forwarded ? forwarded.split(",")[0] : h.get("x-real-ip"))?.trim() || null;
  const userAgent = h.get("user-agent")?.slice(0, 300) ?? null;
  let sessionId: string | null = null;
  try {
    const session = await auth.api.getSession({ headers: h });
    sessionId = session?.session?.id ?? null;
  } catch {
    sessionId = null;
  }
  return { ipAddress, userAgent, sessionId };
}
