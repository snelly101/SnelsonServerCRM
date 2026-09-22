import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { user } from "@/db/schema";
import type { Role } from "@/lib/permissions";

export async function makeUser(role: Role, name = `${role} user`) {
  const id = randomUUID();
  await db.insert(user).values({ id, name, email: `${id}@test.local`, role, emailVerified: true });
  return { id, role, name };
}
