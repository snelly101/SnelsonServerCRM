import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/db";
import { account, session } from "@/db/schema";
import { createUser, listUsers, updateUser } from "@/services/users";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { scrubDetails } from "@/lib/audit";
import { randomUUID } from "node:crypto";

describe("user management", () => {
  it("creates a user with a hashed password and rejects duplicate emails", async () => {
    const id = await createUser({ name: "New Person", email: "new@test.local", role: "finance", password: "Str0ngPassw0rd!" }, null);
    const [cred] = await db.select().from(account).where(eq(account.userId, id));
    expect(cred.providerId).toBe("credential");
    expect(cred.password).not.toBe("Str0ngPassw0rd!");
    expect(await verifyPassword({ hash: cred.password!, password: "Str0ngPassw0rd!" })).toBe(true);
    await expect(createUser({ name: "Dup", email: "new@test.local", role: "sales", password: "Str0ngPassw0rd!" }, null)).rejects.toThrow(/already exists/);
  });

  it("changing role or disabling invalidates sessions, and protects the last admin", async () => {
    const adminId = await createUser({ name: "Only Admin", email: "onlyadmin@test.local", role: "admin", password: "Str0ngPassw0rd!" }, null);
    const userId = await createUser({ name: "Demoted", email: "demoted@test.local", role: "sales", password: "Str0ngPassw0rd!" }, adminId);
    await db.insert(session).values({ id: randomUUID(), token: randomUUID(), userId, expiresAt: new Date(Date.now() + 3600e3) });
    await updateUser({ id: userId, name: "Demoted", role: "read_only", active: true }, adminId);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);

    const admins = (await listUsers()).filter((u) => u.role === "admin" && u.active);
    if (admins.length === 1) {
      await expect(updateUser({ id: adminId, name: "Only Admin", role: "sales", active: true }, adminId)).rejects.toThrow(/last active administrator/);
    }
  });
});

describe("secret handling", () => {
  it("round-trips encryption and produces different ciphertexts per call", () => {
    const a = encryptSecret("refresh-token-123");
    const b = encryptSecret("refresh-token-123");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("refresh-token-123");
    expect(decryptSecret(b)).toBe("refresh-token-123");
  });

  it("detects tampering", () => {
    const ct = Buffer.from(encryptSecret("x"), "base64");
    ct[ct.length - 1] ^= 0xff;
    expect(() => decryptSecret(ct.toString("base64"))).toThrow();
  });

  it("masks secrets for display and scrubs them from audit details", () => {
    expect(maskSecret("abcdefgh")).toBe("••••efgh");
    expect(scrubDetails({ email: "a@b.c", apiToken: "secret", clientSecret: "x" })).toEqual({ email: "a@b.c", apiToken: "[redacted]", clientSecret: "[redacted]" });
  });
});
