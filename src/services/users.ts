import { randomUUID } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db";
import { user, account, session } from "@/db/schema";
import { audit } from "@/lib/audit";
import { ActionError } from "@/lib/action-result";
import type { Role } from "@/lib/permissions";

export async function listUsers() {
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(asc(user.name));
}

/**
 * Creates a staff account with a local password. Better Auth stores local
 * credentials as an `account` row with providerId "credential".
 */
export async function createUser(
  input: { name: string; email: string; role: Role; password: string },
  actorUserId: string | null,
) {
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1);
  if (existing) throw new ActionError("A user with that email already exists.", { email: ["Already in use"] });

  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id,
      name: input.name,
      email: input.email,
      emailVerified: true,
      role: input.role,
      active: true,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: passwordHash,
    });
    await audit(
      { actorUserId, action: "user.create", entityType: "user", entityId: id, details: { email: input.email, role: input.role } },
      tx,
    );
  });
  return id;
}

export async function updateUser(
  input: { id: string; name: string; role: Role; active: boolean; password?: string | null },
  actorUserId: string,
) {
  const [existing] = await db.select().from(user).where(eq(user.id, input.id)).limit(1);
  if (!existing) throw new ActionError("User not found.");

  // Guard against locking everyone out.
  if (existing.role === "admin" && (input.role !== "admin" || !input.active)) {
    const admins = await db.select({ id: user.id }).from(user).where(eq(user.role, "admin"));
    const activeAdmins = admins.filter((a) => a.id !== input.id);
    const remaining = await db.select({ id: user.id, active: user.active }).from(user).where(eq(user.role, "admin"));
    const otherActive = remaining.filter((a) => a.id !== input.id && a.active);
    if (activeAdmins.length === 0 || otherActive.length === 0) {
      throw new ActionError("You cannot remove the last active administrator.");
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({ name: input.name, role: input.role, active: input.active, updatedAt: new Date() })
      .where(eq(user.id, input.id));
    if (input.password) {
      const passwordHash = await hashPassword(input.password);
      const [cred] = await tx
        .select({ id: account.id })
        .from(account)
        .where(eq(account.userId, input.id))
        .limit(1);
      if (cred) {
        await tx.update(account).set({ password: passwordHash, updatedAt: new Date() }).where(eq(account.id, cred.id));
      } else {
        await tx.insert(account).values({
          id: randomUUID(),
          accountId: input.id,
          providerId: "credential",
          userId: input.id,
          password: passwordHash,
        });
      }
    }
    // Deactivating or changing role invalidates existing sessions.
    if (!input.active || input.role !== existing.role) {
      await tx.delete(session).where(eq(session.userId, input.id));
    }
    await audit(
      {
        actorUserId,
        action: "user.update",
        entityType: "user",
        entityId: input.id,
        details: {
          role: { from: existing.role, to: input.role },
          active: { from: existing.active, to: input.active },
          passwordChanged: Boolean(input.password),
        },
      },
      tx,
    );
  });
}
