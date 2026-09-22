import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { assertCan, can, type Action, type Role } from "./permissions";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
};

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
    })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  if (!row || !row.active) return null;
  return row;
});

/** For pages: redirects to /login when signed out. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
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
