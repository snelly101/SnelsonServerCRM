# Phase reports

## Phase 1 — Authentication, permissions, companies, contacts ✅

### What works

- Sign in with email + password; Microsoft 365 SSO switches on when `MICROSOFT_CLIENT_ID/SECRET` are set. No public sign-up; admins create accounts. Sign-in is rate-limited per IP (10/minute) in production builds.
- Six roles with a server-enforced permission matrix (`src/lib/permissions.ts`), shown on Settings → Users. Disabling a user or changing their role kills their sessions. The last active admin cannot be demoted.
- Companies: create/edit/archive/restore, status, owner, industry, website, company/VAT numbers, billing address, tags, typed custom fields, internal notes.
- Sites per company (primary flag); contacts per company with multiple roles and a single primary contact.
- Duplicate detection by company number, VAT, domain, exact normalised name and fuzzy name — live in the form, and blocking on high confidence unless confirmed. Contacts are checked by email.
- Lists with search, filters, sorting, pagination, and saved views (per user, optionally shared).
- CSV import for companies and contacts (duplicates skipped and reported, row-level errors) and CSV export.
- Global search (Ctrl/Cmd-K) across companies and contacts.
- Customer overview with tabs, activity logging, and an append-only timeline.
- Audit log of every write with a field-level diff, viewable by admins.
- Settings: company name, currency, date format, timezone, tax label and rate, device-active window; tags; custom field definitions.
- Worker skeleton (pg-boss) runnable as a long-lived process or a cron tick.
- Docker Compose stack (app, worker, Postgres, Caddy, backups), Debian 12 setup script, deployment and restore documentation.

### What was tested

- **Unit/integration (Vitest, real Postgres):** permission matrix for every role; company create/update/archive with audit and timeline entries; duplicate detection reasons and confidence; contact email uniqueness and single-primary rule; CSV import (created/skipped/error counts) and export; user creation with hashed passwords, session invalidation on role change, last-admin protection; AES-GCM round-trip, tamper detection, secret scrubbing in audit details.
- **Browser (Playwright):** signed-out redirect; admin creates a prospect and a contact and sees them on the overview, duplicate warning appears, global search finds the record; read-only user cannot see write controls, is redirected from `/companies/new` and `/settings/users`, and gets 403 from the export endpoint.

### Remaining dependencies

- Microsoft SSO needs an Entra app registration (redirect `https://<domain>/api/auth/callback/microsoft`) — untested without credentials.
- Live verification of the Debian deployment on the actual 20i VPS.

## Phase 2 — Opportunities, catalogue, tasks, contracts ✅

### What works

- **Sales pipeline.** Configurable stages (Settings → Pipeline stages: add, rename, reorder, set default probability, remove when empty; Won/Lost are fixed). Board view with drag-and-drop between stages (optimistic update, server-confirmed, reverts on error) and a sortable table view; both filterable by owner/search with saved views. Totals: open count, first-year pipeline value, weighted forecast (value × probability), potential MRR.
- **Opportunities.** Owner, primary contact, expected close date, probability (defaults from stage), lead source, next action and date, lost reason, notes, custom fields. Line items from the catalogue or custom, each tagged recurring / project / hardware with pricing model, billing frequency, quantity, price and optional cost. Live summary: MRR, one-off, hardware, first-year value, margin (flagged “estimate” when any cost is missing, “unknown” when none). Mark won (promotes company to customer, optionally creates onboarding and drafts a contract), mark lost with reason, reopen. Tasks and history per opportunity.
- **Service catalogue.** Products grouped by category (managed IT, Microsoft 365, security, backup, networking, hardware, consultancy, other) with pricing model (per user / per device / fixed / one-off), revenue type, frequency, price, cost, margin, and a “compare with NinjaOne device count” flag for per-device lines.
- **Contracts.** Start/end/renewal dates, notice period (notice deadline computed and highlighted), auto-renew, billing frequency, review date and interval, owner, linked opportunity, external proposal id (filled in Phase 3). Contracted lines with **contracted quantity** kept separately from observed device counts (Phase 5); per-device lines can be restricted to a site. MRR/ARR/one-off totals across active contracts with the formula shown on the page. Drafted automatically from a won opportunity (once per opportunity).
- **Tasks.** Owner, due date, priority, links to company/opportunity/contract/onboarding; list with filters (mine, unassigned, overdue, today, week, priority) and saved views; inline complete/reopen/delete; dialogs on every related page. Counts on the dashboard.
- **Onboarding.** Reusable checklist templates (items with day offsets and default owner role); the default template is instantiated **exactly once** per source key (unique index) when an opportunity is won — Phase 3 reuses this with the proposal id as the key. Progress bar, complete when all items done.
- **Reminders.** Daily worker job (and a manual “Run reminders” button): creates a renewal task 30 days before the notice deadline and a review task 14 days before the review date, each once (task source keys), and expires non-auto-renewing contracts past their end date.
- **Customer overview** now has live Opportunities, Contracts (with MRR) and Tasks/Onboarding tabs. **Dashboard** shows pipeline value and weighted forecast, MRR/ARR, my tasks (overdue highlighted), and renewals in the next 90 days.
- Sample data: 13 catalogue items, 7 opportunities across stages (incl. one won, one lost), 5 active contracts, tasks.

### What was tested

- **Unit/integration (12 new tests, 37 total):** revenue maths (monthly normalisation of quarterly/annual lines, one-off vs hardware split, estimate flag, unknown margin); form line parsing; opportunity creation with stage probability and board placement; stage moves with default probability and refusal of closed stages; mark-won promotes company, creates onboarding once (second call returns the same id), drafts contract once, refuses edits when closed; mark-lost/reopen; **5 concurrent onboarding creations with the same key produce one row**; MRR only counts active contracts; reminders create renewal + review tasks once and never twice; expiry of non-auto-renewing contracts; overdue task listing and completion; company derivation from linked opportunity.
- **Browser (2 new tests, 5 total):** create prospect → opportunity with a line item (live MRR £450 shown) → mark won → onboarding and draft contract links appear → company is a customer → checklist tasks visible on the company → complete an item on the onboarding page; catalogue and contracts pages render with MRR formula.
- `next build`, ESLint and `tsc` clean.

### Bugs found and fixed during the phase

- Drizzle renders `${table.column}` unqualified inside `sql` templates when the outer query has no joins, which broke correlated subqueries; they now reference the outer table by name.
- `z.coerce.boolean()` treats the string `"false"` as `true`; replaced with an explicit `boolish` parser for every checkbox field.
- `current_date + $1` needs an explicit `::int` cast in Postgres.

### Remaining dependencies

- None for this phase. Proposal-driven acceptance (Phase 3) will call the same `markWon` + `createOnboardingOnce` path.

## Phase 3 — Better Proposals (next)

## Phase 4 — Xero

## Phase 5 — NinjaOne

## Phase 6 — Reporting, reliability, deployment docs
