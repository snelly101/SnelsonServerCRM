import { describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { session, twoFactor, user, verification } from "@/db/schema";
import { auth } from "@/lib/auth";
import { totp } from "@/lib/totp";
import { twoFactorPolicy } from "@/lib/session";
import { createUser, listUsers, resetTwoFactor, revokeTrustedDevices } from "@/services/users";
import { auditLog } from "@/db/schema";
import { desc } from "drizzle-orm";

const PASSWORD = "Str0ngPassw0rd!";

describe("two-factor policy", () => {
  const settings = (roles: string[], deadline: string | null) => ({ twoFactorRequiredRoles: roles, twoFactorDeadline: deadline });
  it("requires enrolment only for listed roles with a CRM password", () => {
    expect(twoFactorPolicy({ role: "technician", twoFactorEnabled: false, hasPassword: true }, settings(["technician"], null)).mustEnrol).toBe(true);
    expect(twoFactorPolicy({ role: "sales", twoFactorEnabled: false, hasPassword: true }, settings(["technician"], null)).required).toBe(false);
    expect(twoFactorPolicy({ role: "technician", twoFactorEnabled: false, hasPassword: false }, settings(["technician"], null)).required).toBe(false);
    expect(twoFactorPolicy({ role: "technician", twoFactorEnabled: true, hasPassword: true }, settings(["technician"], null)).mustEnrol).toBe(false);
  });
  it("turns the block into a reminder while the grace period runs", () => {
    const p = twoFactorPolicy({ role: "admin", twoFactorEnabled: false, hasPassword: true }, settings(["admin"], "2030-01-01"), "2029-12-31");
    expect(p.mustEnrol).toBe(false);
    expect(p.dueBy).toBe("2030-01-01");
    const after = twoFactorPolicy({ role: "admin", twoFactorEnabled: false, hasPassword: true }, settings(["admin"], "2030-01-01"), "2030-01-02");
    expect(after.mustEnrol).toBe(true);
    expect(after.dueBy).toBeNull();
  });
});

async function signIn(email: string) {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
  const raw = res.headers.getSetCookie();
  const body = (await res.json()) as { twoFactorRedirect?: boolean; token?: string };
  const headers = new Headers({ cookie: raw.map((c) => c.split(";")[0]).join("; ") });
  return { body, headers };
}

describe("two-factor enrolment through the auth API", () => {
  it("enable → verify makes the second factor active, sign-in then returns a challenge, a valid code completes it, and the secret is stored encrypted", async () => {
    const userId = await createUser({ name: "Two Factor", email: "twofactor@test.local", role: "technician", password: PASSWORD }, null);
    const first = await signIn("twofactor@test.local");
    expect(first.body.twoFactorRedirect).toBeUndefined();

    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: first.headers });
    expect("totpURI" in enabled).toBe(true);
    const uri = (enabled as { totpURI: string; backupCodes: string[] }).totpURI;
    const backupCodes = (enabled as { backupCodes: string[] }).backupCodes;
    expect(backupCodes).toHaveLength(10);
    const secret = new URL(uri).searchParams.get("secret")!;
    // Not active until a code is verified
    let [u] = await db.select({ enabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
    expect(u.enabled).toBe(false);
    await expect(auth.api.verifyTOTP({ body: { code: "000000" }, headers: first.headers })).rejects.toThrow();
    await auth.api.verifyTOTP({ body: { code: totp(secret).code }, headers: first.headers });
    [u] = await db.select({ enabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
    expect(u.enabled).toBe(true);
    const [row] = await db.select().from(twoFactor).where(eq(twoFactor.userId, userId));
    expect(row.secret).not.toContain(secret);
    expect(row.backupCodes).not.toContain(backupCodes[0]);

    // Password alone no longer yields a session
    const second = await signIn("twofactor@test.local");
    expect(second.body.twoFactorRedirect).toBe(true);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toHaveLength(1); // only the first session
    await expect(auth.api.verifyTOTP({ body: { code: "123456" }, headers: second.headers })).rejects.toThrow();
    const done = await auth.api.verifyTOTP({ body: { code: totp(secret).code, trustDevice: true }, headers: second.headers, asResponse: true });
    expect(done.ok).toBe(true);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toHaveLength(2);
    expect(await db.select().from(verification).where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, userId)))).toHaveLength(1);

    // A recovery code signs in once
    const third = await signIn("twofactor@test.local");
    expect(third.body.twoFactorRedirect).toBe(true);
    await auth.api.verifyBackupCode({ body: { code: backupCodes[0] }, headers: third.headers });
    const fourth = await signIn("twofactor@test.local");
    await expect(auth.api.verifyBackupCode({ body: { code: backupCodes[0] }, headers: fourth.headers })).rejects.toThrow();

    // Trusted browsers can be forgotten; admin reset removes everything and is audited
    expect(await revokeTrustedDevices(userId, userId)).toBe(1);
    expect((await listUsers()).find((x) => x.id === userId)?.twoFactorEnabled).toBe(true);
    const admin = await createUser({ name: "Reset Admin", email: "resetadmin@test.local", role: "admin", password: PASSWORD }, null);
    await resetTwoFactor(userId, admin);
    expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, userId))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
    expect((await listUsers()).find((x) => x.id === userId)?.twoFactorEnabled).toBe(false);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "user.two_factor.reset")).orderBy(desc(auditLog.at)).limit(1);
    expect(entry.actorUserId).toBe(admin);
    expect(entry.entityId).toBe(userId);
    const fifth = await signIn("twofactor@test.local");
    expect(fifth.body.twoFactorRedirect).toBeUndefined();
  });
});
