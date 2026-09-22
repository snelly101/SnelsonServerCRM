import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { ROLES } from "./permissions";

const microsoftEnabled = Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

/**
 * Better Auth server instance. Sessions are stored in Postgres.
 * - Email + password for local accounts (admin-created; no public sign-up).
 * - Microsoft 365 / Entra ID single sign-on when configured.
 * A user's `role` is read from the database on every request; it is never
 * trusted from the client.
 */
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.APP_URL,
  // During `next build` no runtime secret exists; a placeholder keeps page-data collection quiet. Runtime still requires the real value.
  secret: process.env.BETTER_AUTH_SECRET ?? (process.env.NEXT_PHASE === "phase-production-build" ? "build-placeholder-secret-not-used-at-runtime" : undefined),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Accounts are created by an administrator from Settings -> Users.
    disableSignUp: true,
    minPasswordLength: 10,
  },
  socialProviders: microsoftEnabled
    ? {
        microsoft: {
          clientId: process.env.MICROSOFT_CLIENT_ID!,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
          tenantId: process.env.MICROSOFT_TENANT_ID ?? "common",
          prompt: "select_account",
        },
      }
    : {},
  user: {
    additionalFields: {
      role: {
        type: ROLES as unknown as string[],
        required: false,
        defaultValue: "read_only",
        // Role changes go through the admin-only server action, never the auth API.
        input: false,
      },
      active: { type: "boolean", required: false, defaultValue: true, input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 12, // 12 hours
    updateAge: 60 * 60, // refresh once an hour of activity
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  // Brute-force protection on the sign-in endpoint (per IP). Applies in
  // production builds; other endpoints share the general window.
  rateLimit: {
    enabled: process.env.NODE_ENV === "production",
    window: 60,
    max: 100,
    customRules: {
      // Per-IP sign-in attempts per minute. Override only for automated browser tests.
      "/sign-in/email": { window: 60, max: Number(process.env.AUTH_SIGN_IN_MAX_PER_MINUTE) || 10 },
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  plugins: [nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
export const isMicrosoftSsoEnabled = microsoftEnabled;
