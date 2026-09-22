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

## Phase 3 — Better Proposals ✅

### Verified against vendor documentation

Outbound access was opened during this phase, so the connector is built on primary sources: the Better Proposals API page and its published example request/response scripts, Xero's official OpenAPI specs, and NinjaOne's OpenAPI YAML and OAuth article. The verified capability matrix is in [integrations.md](integrations.md). Two findings shaped the design: Better Proposals **documents no webhooks** (so the CRM polls), and `POST /proposal/create` **accepts no line-item pricing** (so pricing is a hand-off to Better Proposals with a deep link).

### What works

- **Shared integration framework** (used by Xero and NinjaOne next): encrypted per-provider connection row with status, last test/sync, last error and a circuit breaker; bidirectionally-unique external links; `sync_runs` + `sync_errors` history; `inbound_events` de-duplication; `outbound_requests` idempotency ledger (`runOutbound`: reuse / reconcile / in-flight guard); `mapping_conflicts` review queue; a shared HTTP client with timeout, jittered backoff, `Retry-After`, 4xx-no-retry and rate spacing.
- **Integrations page:** provider cards with status (demo clearly labelled as *not connected*), account, last successful sync, pause state, last error, *Test* and *Sync now*; needs-review list with resolve/dismiss; sync history with per-run error drill-down. Per-provider page for Better Proposals: token entry (verified against `/settings` before being stored encrypted), disconnect, default template, recent runs, unresolved errors, record mapping with unlink, and the outbound ledger.
- **Better Proposals connector** (`src/connectors/betterproposals/live.ts`): `Bptoken` auth, form-encoded create, list by status with pagination, templates, companies, merge tags, settings/brand; string flags and `0000-00-00` dates normalised. Demo adapter kept separate (`demo.ts`), only active with `DEMO_MODE=true` and no token, never reported as connected.
- **Opportunity → proposal:** *Create proposal* dialog (template, recipients with the signer first, merge-tag values). Creates the Better Proposals company once per CRM company (reconciling by normalised name on retry) and the proposal once per opportunity version; stores the external id and `ProposalView`/`Preview` URLs; timeline entry. Progress strip draft → sent → opened → signed with dates, totals, cached/stale label and *Open in Better Proposals*.
- **Polling:** worker job every 15 min (singleton) and manual sync. Overlays the status lists, records each transition as one inbound event and timeline entry.
- **Acceptance exactly once:** on signed/paid, the opportunity is marked won, the company promoted, onboarding created with key `proposal:<id>`, a contract drafted and stamped with the proposal id, and `acceptance_processed_at` set. Re-polls, paid transitions and manual reruns are no-ops.
- **Unlinked proposals** (signed but not linked, or name-only matches) raise review items instead of guesses; the Proposals page can link a proposal to an opportunity or company, and linking a signed one runs acceptance.
- Proposals page (filters, unlinked filter, saved views) and a Proposals tab on the company overview.

### What was tested

- **15 new unit/integration tests (52 total):** HTTP retry on 429 with `Retry-After`, no retry on 4xx, give-up on 5xx, `Retry-After` parsing; live client against a fake API (header, form encoding of contacts/merge tags, status normalisation, 404 → null); credential encryption round trip; link uniqueness both ways; inbound de-dup; outbound perform-once / reuse / reconcile-after-failure / in-flight block; sync run bookkeeping, partial status, circuit breaker opening after three failures and skipping scheduled runs; proposal creation idempotent per version with company + opportunity links; validation of missing emails; full poll flow open → signed → won + onboarding once + contract stamped, with paid and reruns as no-ops; unlinked signed proposal → review item.
- **3 new browser tests (8 total):** Integrations page shows demo status, *Sync now* records a `proposals.poll` run; create a proposal from an opportunity (demo) and see it on the opportunity and Proposals pages; read-only user has no Test/Sync controls.

### Remaining dependencies

- **Live verification** needs your Better Proposals API token (Premium plan): paste it on Integrations → Better Proposals. The token is verified before it is stored. Until then the demo adapter is in use and labelled as such.
- The create response's field names beyond `ID`/`ProposalView` are not shown in the vendor docs; the connector re-reads the proposal after creation so nothing depends on them.


## Phase 4 — Xero ✅

### What works

- **Connect flow in the web UI.** *Connect to Xero* starts the OAuth 2.0 authorization-code flow (state stored server-side with a 10-minute expiry), the callback exchanges the code, stores the tokens encrypted and lists the authorised organisations; the admin then **explicitly picks the organisation** (tenant id recorded). Only the Xero *app's* client id/secret and webhook key live in `.env`, because Xero validates the redirect URI against the app registration.
- **Token handling.** Access tokens refresh automatically before expiry or on a 401; refresh tokens rotate and the new set is persisted immediately; concurrent requests share one in-flight refresh so the rotating token is never burned twice. Requests carry `xero-tenant-id`, are spaced to stay under 60/min, honour `Retry-After` on 429 and never retry other 4xx.
- **Sync.** Hourly incremental sync of contacts, sales invoices and payments using `If-Modified-Since` (with a 10-minute overlap), nightly full reconciliation, manual *Sync now* and *Full reconciliation*. Mirrors carry `fetched_at`; the Finance page labels figures cached/stale. Archived Xero contacts keep their link, are marked `archived`, and raise a review item.
- **Webhooks.** `POST /api/webhooks/xero` verifies `x-xero-signature` (base64 HMAC-SHA256 of the raw body, constant-time compare), returns 401 on mismatch (satisfies Xero's intent-to-receive check), records events idempotently and returns 200 immediately; a worker job applies them every minute by re-fetching the changed contact/invoice. Missed deliveries are recovered by the hourly sync.
- **Customer mapping screen.** Every CRM company with its Xero link and ranked suggestions (company number, VAT/tax number, email domain → high; exact normalised name → medium; similar name → low). Links are made only by a person; one Xero contact can never map to two companies. *Create in Xero* makes a contact from CRM data once (idempotent, reconciled by name on retry) and is refused when a likely duplicate exists.
- **Field ownership.** Xero owns legal name, addresses, tax number, balances, invoice status and payments; the CRM never writes them. Email/phone can be pushed only by an explicit *Push* click and the push is refused (with a review item) when Xero's copy changed after the last sync and differs. Nothing is overwritten silently.
- **Draft invoices.** *Prepare invoice* on an active contract (billing period → recurring lines, annual/quarterly lines normalised to the period) or a won opportunity (one-off and hardware lines). Configured account codes (services/hardware), tax type, payment terms and branding theme from Xero's own lists. A finance user reviews, edits lines, then *Approve and create in Xero*: created as **DRAFT** with a unique `Reference` (`CRM-XXXXXXXX`), an `Idempotency-Key`, and the CRM's outbound ledger; a retry after failure looks the invoice up by reference first. The CRM never authorises or sends.
- **Finance page** (finance/admin only): outstanding, overdue, paid last 30 days, drafts in Xero, CRM drafts awaiting approval; invoice list with filters and unlinked-contact warnings; draft review page. **Company overview → Invoices tab:** Xero balances (outstanding/overdue from the contact record), 12-month invoiced/paid, invoice history, pending drafts — hidden from roles without `finance.read`.
- Worker jobs: `xero.sync` hourly, `xero.reconcile` nightly, `xero.inbound` every minute.

### What was tested

- **14 new unit/integration tests (66 total):** single-flight rotating token refresh under concurrent requests with persistence; `If-Modified-Since` and `Idempotency-Key` headers and DRAFT-only invoice bodies; webhook HMAC verification and Xero date parsing; incremental sync (second run creates nothing); match suggestions by VAT/domain/name without auto-linking; linking attaches invoices and surfaces Xero balances; duplicate-contact refusal and create-once; prepare → approve creates one DRAFT, second approval reuses it, ledger has one row, permissions matrix for prepare/approve; approval refused when unlinked; webhook events recorded once, applied by the worker, payment reaches the right company; field-ownership conflict then successful explicit push; one timeline event per polled status change; circuit breaker skips scheduled but not manual syncs; cancelled drafts cannot be approved.
- **3 new browser tests (11 total):** finance user sees demo invoices, prepares a draft from a contract and approves it once; sales user is blocked from Finance and sees "Finance data is restricted" on the company page; admin sees the Xero page with demo status, mapping table and field-ownership notes.

### Remaining dependencies (live verification)

1. Create the Xero app at developer.xero.com (Web app), redirect URI `https://<domain>/api/integrations/xero/callback`, scopes as listed in `docs/integrations.md`; put `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` in `.env`.
2. Register the webhook `https://<domain>/api/webhooks/xero` for Contacts and Invoices and put the key in `XERO_WEBHOOK_KEY`.
3. In the CRM: Integrations → Xero → *Connect to Xero* → choose the organisation → set invoice defaults → map customers.


## Phase 5 — NinjaOne ✅

### Verified against vendor documentation

- OpenAPI spec `https://eu.ninjarmm.com/apidocs-beta/NinjaRMM-API-v2.yaml` (organisations, locations, `devices-detailed`, `queries/device-health` cursor paging, node classes), the OAuth article (API Services → `client_credentials`, scope `monitoring`), and a live probe of `POST https://eu.ninjarmm.com/ws/oauth/token` (rejects bad credentials with a JSON error, confirming the endpoint and content type).

### What works

- **Connect in the web UI.** Integrations → NinjaOne: region (EU default), client id and client secret. Credentials are **verified against the live token endpoint before they are stored** (encrypted, AES-256-GCM); the short-lived access token is cached encrypted alongside them. Test, Sync now, Disconnect. Only the `monitoring` scope is ever requested and the live client has no write method at all.
- **Read-only mirror.** Hourly job (`ninjaone.sync`, `:20`) pages through organisations, their locations, `devices-detailed` (`after` paging) and `device-health` (cursor paging). Devices carry name, type (`nodeClass`), OS, last-seen, online/offline, approval status, health, patch/threat/alert counts, IPs and the raw record. Organisations and devices that disappear from NinjaOne are kept and marked `deleted`, never dropped; a linked organisation disappearing raises a review conflict.
- **Mapping is always a human decision.** Organisation → company suggestions by normalised name only (exact vs similar), shown next to a free company picker; nothing links automatically, one organisation can never map to two companies and vice versa. Locations link to sites only after the organisation is linked, and only to that company's sites. Linking assigns devices to the company/site; unlinking clears them and dismisses open items.
- **Counting rules.** Settings → General *Device active window* (default 30 days) decides what is active; Integrations → NinjaOne *Counting rules* choose which node classes are billable (workstations, servers, VMs by default; printers, switches and hypervisor hosts excluded) and whether only APPROVED devices count.
- **Discrepancy engine.** For every line marked *Compare with NinjaOne* on an active contract of a linked company: observed = active, approved, billable-class devices at the organisation (or at the linked location when the line is site-specific; unlinked sites are skipped, never guessed). A difference opens a review item with the contracted qty, observed qty, difference and an estimated unbilled/over-billed amount per period. Re-checks after every sync, link change and rule change keep items current: matched counts resolve the item, *accepted* items re-open only if the gap grows, *dismissed* stays dismissed. Reviewing records who decided and why in the audit log and the company timeline. **Nothing changes a contract or invoice.**
- **Devices page** (all roles): totals (total, active, online, servers, needs attention, unmapped), the discrepancy queue with accept/dismiss (account manager, finance, admin), and a filterable, searchable, pageable device list with freshness labels (live/cached/stale) and NinjaOne console deep links. **Company → Devices tab** with counts, contract-vs-observed, device list and *Open in NinjaOne*. **Contract → Device count check** shows observed vs contracted per line. Dashboard shows active devices, open discrepancies and connector status.

### What was tested

- **10 new unit/integration tests (76 total):** live client fetches one token for concurrent calls, sends Bearer, re-fetches on 401, pages health by cursor, exposes no write method; epoch timestamps; freshness thresholds; demo mode is never "connected"; sync mirrors orgs/locations/devices/health and is idempotent; suggestions never auto-link, org link required before site link, one org cannot serve two companies; observed counts exclude stale devices and non-billable classes and respect site scope (Harrowgate 19 vs 18 → +1, Northern Freight 38 vs 40 → −2, site lines matched); accept then gap-grows re-open then match resolves; deleted devices retained and excluded from active lists; rule changes re-count; unlink clears ownership/site links/open items; a vanished linked organisation raises a conflict and recovers.
- **3 new browser tests (14 total):** account manager sees demo devices, totals and the discrepancy queue and accepts one; company Devices tab and contract device check show observed counts; admin sees the NinjaOne page as *Demo (not connected)* with 5 of 6 organisations mapped, technician gets no connect form and no review buttons.

### Remaining dependencies (live verification)

1. In NinjaOne (EU): Administration → Apps → API → Client app IDs → Add → *API Services (machine-to-machine)*, scope **Monitoring** only. Note the client id and secret.
2. In the CRM: Integrations → NinjaOne → region EU → paste id and secret → *Verify and connect* → *Sync now* → link organisations to companies (and locations to sites for site-specific lines).
3. Review the billable node classes for your billing policy, then check the Devices page queue.


## Phase 6 — Reporting, reliability, deployment docs
