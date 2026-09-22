# Phase reports

## Phase 1 — Authentication, permissions, companies, contacts ✅

### What works

- Sign in with email + password; Microsoft 365 SSO switches on when `MICROSOFT_CLIENT_ID/SECRET` are set. No public sign-up; admins create accounts.
- Six roles with a server-enforced permission matrix (`src/lib/permissions.ts`), shown on Settings → Users. Disabling a user or changing their role kills their sessions. The last active admin cannot be demoted.
- Companies: create/edit/archive/restore, status, owner, industry, website, company/VAT numbers, billing address, tags, typed custom fields, internal notes.
- Sites per company (primary flag); contacts per company with multiple roles and a single primary contact.
- Duplicate detection by company number, VAT, domain, exact normalised name and fuzzy name — live in the form, and blocking on high confidence unless confirmed. Contacts are checked by email.
- Lists with search, filters, sorting, pagination, and saved views (per user, optionally shared).
- CSV import for companies and contacts (duplicates skipped and reported, row-level errors) and CSV export.
- Global search (Ctrl/Cmd-K) across companies and contacts.
- Customer overview with tabs (later-phase tabs are labelled as such), activity logging, and an append-only timeline.
- Audit log of every write with a field-level diff, viewable by admins.
- Settings: company name, currency, date format, timezone, tax label and rate, device-active window; tags; custom field definitions.
- Worker skeleton (pg-boss) with a heartbeat queue, runnable as a long-lived process or a cron tick.
- Docker Compose stack (app, worker, Postgres, Caddy, backups), Debian 12 setup script, deployment and restore documentation.

### What was tested

- **Unit/integration (Vitest, real Postgres, 25 tests):** permission matrix for every role; company create/update/archive with audit and timeline entries; duplicate detection reasons and confidence; contact email uniqueness and single-primary rule; CSV import (created/skipped/error counts) and export; user creation with hashed passwords, session invalidation on role change, last-admin protection; AES-GCM round-trip, tamper detection, secret scrubbing in audit details.
- **Browser (Playwright, 3 tests):** signed-out redirect; admin creates a prospect and a contact and sees them on the overview, duplicate warning appears, global search finds the record; read-only user cannot see write controls, is redirected from `/companies/new` and `/settings/users`, and gets 403 from the export endpoint.
- `next build` succeeds; ESLint and `tsc` are clean.

### Remaining dependencies

- Microsoft SSO needs an Entra app registration (redirect `https://<domain>/api/auth/callback/microsoft`) — untested without credentials.
- Live verification of the Debian deployment on the actual 20i VPS.

## Phase 2 — Opportunities, catalogue, tasks, contracts (next)

## Phase 3 — Better Proposals

## Phase 4 — Xero

## Phase 5 — NinjaOne

## Phase 6 — Reporting, reliability, deployment docs
