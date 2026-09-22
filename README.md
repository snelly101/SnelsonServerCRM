# Snelson Server CRM

A CRM built for an IT Managed Service Provider. It manages the customer lifecycle from lead to renewal and integrates with **Better Proposals** (proposals), **Xero** (accounting) and **NinjaOne** (RMM).

> **Status:** Phases 1–3 complete — authentication and roles, companies/contacts/sites, sales pipeline, service catalogue, opportunities, contracts with MRR, tasks and onboarding, the shared integration framework (encrypted credentials, idempotent inbound/outbound, sync history, review queue) and the **Better Proposals** connector with polling and exactly-once acceptance. Phases 4–5 add Xero and NinjaOne. See [docs/phases.md](docs/phases.md).

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Database | PostgreSQL 16, Drizzle ORM, SQL migrations in `drizzle/` |
| Jobs | pg-boss (Postgres-backed queue). Long-running worker **or** cron tick |
| Auth | Better Auth — email/password plus optional Microsoft 365 SSO |
| Tests | Vitest (real Postgres), Playwright (browser) |
| Deploy | Docker Compose on Debian 12: app, worker, Postgres, Caddy (auto-HTTPS), nightly backups |

## Quick start (development)

```bash
# 1. Prerequisites: Node 20+, PostgreSQL 16 (local or Docker)
createdb crm && createdb crm_test

# 2. Configure
cp .env.example .env
#    set DATABASE_URL, TEST_DATABASE_URL,
#    APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
#    BETTER_AUTH_SECRET=$(openssl rand -base64 32)

# 3. Install, migrate, seed
npm install
npm run db:migrate
npm run db:seed          # creates demo users + sample customers

# 4. Run
npm run dev              # http://localhost:3000
npm run worker           # background jobs (separate terminal)
```

Sign in with `admin@example.com` / `Admin12345!` (seed data only — change or delete before production).

Seeded accounts, one per role: `admin@`, `sales@`, `am@` (account manager), `finance@`, `tech@`, `readonly@example.com`, all with the same password.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run worker` | Long-running job worker (VPS / Docker) |
| `npm run jobs:tick` | Process jobs for ~50 s then exit — for cron on hosts without a persistent worker |
| `npm run db:generate` | Generate a SQL migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Load demo users and sample data (idempotent) |
| `npm run db:reset` | Drop and recreate the schema (dev/test only) |
| `npm test` | Unit/integration tests against `TEST_DATABASE_URL` |
| `npm run test:e2e` | Playwright browser tests against a running server |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |

## Project layout

```
src/
  app/            Next.js routes. (app)/ = signed-in area, login/, api/
  actions/        Server actions: permission check → validate → service → revalidate
  services/       Business logic (testable without HTTP)
  db/             Drizzle schema, migrations runner, seed, reset
  lib/            auth, permissions, session, audit, crypto, validation, formatting
  components/     UI (ui/ = primitives, others = feature components)
  worker/         pg-boss worker, cron tick, job registry
  connectors/     Per-provider live client + demo adapter (betterproposals/, xero/, ninjaone/)
drizzle/          SQL migrations (generated, reviewed, committed)
tests/unit        Vitest; tests/e2e Playwright
deploy/           Caddyfile, backup script, Debian server setup script
docs/             Architecture, deployment, integrations, phase reports
```

## Security model (summary)

- Roles: `admin`, `sales`, `account_manager`, `finance`, `technician`, `read_only`. The matrix is in `src/lib/permissions.ts` and shown on Settings → Users.
- Every server action and API route calls `requireActionPermission(action)`; the UI only hides controls.
- A user's role is read from the database on every request, never from the client. Changing a role or disabling a user deletes their sessions.
- Integration credentials are encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`). They are never sent to the browser; the logger redacts token-like fields.
- No customer passwords or remote-access credentials are stored anywhere.
- Every create/update/archive and every sensitive action is written to `audit_log` with a field-level diff.

## Documentation

- [docs/architecture.md](docs/architecture.md) — data model, request flow, job system, integration design
- [docs/integrations.md](docs/integrations.md) — capability matrix and setup for Better Proposals, Xero, NinjaOne
- [docs/deployment.md](docs/deployment.md) — Debian 12 VPS setup, Docker Compose, backups and restore, shared-hosting variant
- [docs/phases.md](docs/phases.md) — what each phase delivered, what was tested, what remains
