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


## Phase 6 — Reporting, reliability, deployment docs ✅

### What works

- **Reports page** (`/reports`, every role; the invoices tab needs `report.finance.read`): open pipeline by stage (count, first-year value, weighted, MRR-if-won, past-close counts); **weighted forecast** for the next six months by expected close month with past-due and unscheduled rows, formula printed and marked *estimate*; **recurring revenue** with the documented MRR formula on the page, MRR/ARR, gross margin on MRR (marked *estimate* when any line lacks a cost), customer concentration, MRR by customer with share and margin, MRR by service category; **renewals** in 30/60/90-day buckets with MRR at stake, notice deadlines passed, review dates overdue; **overdue tasks** by owner and the oldest fifty; **outstanding invoices** from the Xero mirror with a freshness label and per-customer breakdown; **devices** with active/billable counts and the estimated unbilled/over-billed amount from open discrepancies; **integration health** with worker heartbeat, per-provider status, runs/failures/item errors in 24 h and open conflicts. Six reports export to CSV through the audited export route.
- **Worker heartbeat.** Both runners (`npm run worker` and the cron `jobs:tick`) write a heartbeat at start and every 5 minutes into `system_status`. The Integrations page shows *worker alive / stale / never* and a red banner when it is not alive; `GET /api/health` (unauthenticated, no data) returns 200 only when the database answers and a heartbeat landed within 15 minutes, otherwise 503, for uptime monitors and the Docker healthcheck.
- **Data retention job** (`system.retention`, nightly 03:15): sync runs and their errors after 90 days, processed webhook payloads after 30 days. Audit log, activities, mirrored records, links and discrepancies are kept; customer data is never deleted by a job. Documented in `docs/architecture.md`.
- **Deployment docs finalised** for the Debian 12 VPS: health endpoint, worker monitoring, restore drill, update procedure, secrets checklist, and the shared-hosting cron variant.

### What was tested

- **6 new unit/integration tests (82 total):** MRR formula across monthly/quarterly/annual lines with one-off excluded, per-customer margin and estimate flags, category grouping, CSV header and rows; pipeline by stage and forecast buckets (next month, past-due, unscheduled); renewal buckets and notice deadlines; overdue tasks by owner excluding done and future; finance/device/health reports label demo data and never show a demo connector as connected; heartbeat alive → stale; retention deletes only old processed rows.
- **2 new browser tests (16 total):** finance user walks every report tab and downloads a CSV; sales user has no invoices tab, gets 403 on the invoice export, and `/api/health` answers with database and worker fields.

### Remaining dependencies

None in code. Going live needs the VPS (docs/deployment.md), then the three sets of API credentials entered in the web UI (Better Proposals token, Xero app + connect, NinjaOne client id/secret).


## Phase 7 — Secure Vault (customer credentials) ✅

Built to the architecture in [`docs/secure-vault-plan.md`](secure-vault-plan.md) with the owner's decisions: master key as an environment variable (KMS later), 30-minute step-up window using the CRM password, grants for administrators and technicians only, 60 reveals per 10 minutes with an admin alert, archived items kept indefinitely, TOTP in v1, SSH keys later, everything else in one go.

### What works

- **Secure Vault tab** on every customer (visible only to users with a grant or the admin role): search and filter by name, username, URL, reference, category and tag; favourites first; category, tag, review and expiry badges; per-secret **Reveal** (auto-hides after the configured seconds and whenever the tab is hidden), **Copy** (never displays the value; clipboard cleared after the configured seconds while the tab is focused), **authenticator code** for TOTP secrets without exposing the seed, **History** per item, edit, archive and restore.
- **Item model**: name, category, username, URL, account/reference, site, tags, favourite, review and expiry dates as searchable metadata; password, secure notes, TOTP secret (base32 or otpauth URI), recovery codes, API key and custom secure fields inside one encrypted JSON document, so new secret kinds are additive. Password generator (CSPRNG, unbiased) with a strength meter.
- **Encryption**: per-item AES-256-GCM data keys wrapped by `VAULT_MASTER_KEY` (envelope), AAD binding each ciphertext to its item and customer, fresh data key on every save, key versioning with fingerprint check, rotation by re-wrap, buffers zeroed after use. The worker never receives the key.
- **Permissions**: role gate (`vault.use` for technicians, `vault.admin` for administrators) plus per-user grants with eight independent capabilities, scoped to all customers or one, with optional expiry. Plaintext is returned only by the reveal and TOTP actions and only to users holding the capability; usernames are masked without *view usernames*.
- **Step-up**: reveal and copy require the CRM password to have been confirmed within the window; five failures lock step-up for 15 minutes.
- **Rate limit**: reveals, copies and codes per user per 10 minutes; breaching it blocks further reveals, writes a `rate_limited` audit row and raises an urgent task for an administrator.
- **Audit**: append-only table enforced by database triggers, SHA-256 hash chain verified nightly and on demand, IP, user agent and session on every row, a row per create / view / reveal / copy / code / modify (field names only) / archive / restore / grant change / step-up result / rate limit / re-wrap. Mirrored into the general audit log. Admin audit page with customer, user and action filters; per-item history.
- **Settings → Secure Vault**: key status, chain status, re-wrap, behaviour settings (reveal timeout, clipboard clear, step-up window, reminder lead time, reveal limit), grants table, categories (twelve built-in plus custom).
- **Reminders**: daily tasks for credentials whose review or expiry date is within the lead time (metadata only, runs in the worker).
- **Leak prevention**: log redaction paths for every secret field, generic error messages, audit detail scrubbing, no browser storage, vault tables excluded from search and exports, `/api/health` exposes booleans only.

### What was tested

- **13 unit/integration tests (98 total)**: seal/open round-trip, AAD binding and tamper detection, key rotation re-wrap, generator classes and uniqueness, RFC 6238 TOTP vectors and otpauth parsing; capability resolution (admin, technician before/after grants, sales refused, copy never exceeding reveal, company scoping); ciphertext contains no secret, listing returns metadata only, username masking; reveal refused without capability and without step-up, wrong password refused and audited, correct password opens the window, reveal/copy/TOTP audited with field, IP and user agent; update keeps untouched secrets and records only field names; archived items cannot be revealed; database refuses updates and deletes on the audit table; a forged row breaks the chain at that row; the reveal limit blocks and raises the admin task; reminders create tasks once; revoked grants stop access; errors carry no secret text.
- **2 browser tests (18 total)**: admin adds an item, is challenged for their password, a wrong password is refused, reveal shows and hides the secret, the page source never contains the secret before or after, history lists the events; technician without a grant and sales have no vault tab or settings; admin audit page lists the reveal.

### Remaining dependencies

- Generate `VAULT_MASTER_KEY` on the VPS and store it per docs/deployment.md §5a before creating any items.
- Grant technicians access under Settings → Secure Vault.
- Later (per decisions): external KMS for the master key, SSH private keys as a secret kind.

## Phase 8 — 20i Hosting ✅

### Verified against vendor documentation

Public 20i API guides (bearer auth with the base64-encoded general API key, `GET /package` response fields, package provisioning guide) and the community endpoint references derived from the Apiary reference behind the reseller login. The `/domain`, mailbox and usage response shapes are only partly documented publicly, so the client parses them defensively and keeps raw JSON; a live account check remains on the list below.

### What works

- **Connector** (`src/connectors/twentyi/`): read-only live client (`GET /reseller`, `/package`, `/package/{id}/web/usage`, `/package/{id}/email/{domain}/mailbox`, `/domain`), retries with backoff, tolerant token encoding (base64 per the docs, raw fallback), and a demo adapter with seven packages, eight domains (one expiring in 12 days, one in 24, one expired) and five mailboxes.
- **Mirror** (`hosting_items`): packages, domains (attached to their package), mailboxes; disk usage; deleted-at-20i marking; hourly `twentyi.sync` plus *Sync now*.
- **Company linking**: automatic on exact registrable-domain match against company website or contact email domains (ambiguous matches become suggestions); manual link/unlink from the mapping table with domain and name suggestions; mailboxes follow their package; unlinks are remembered.
- **Billing**: on the company's **Hosting** tab each package and domain is tied to the contract line that bills it (must belong to the company); *not billed* is flagged on both pages; the tab also lists mirrored Xero invoices whose lines mention the hosting names.
- **Reminders**: daily tasks for domains and certificates expiring inside the configurable window, urgent once expired, owned by the account owner.
- **Integrations page** card, per-provider page with stats (packages, domains, mailboxes, expiring, unlinked / unbilled), sync history and errors; Reports integration health includes 20i.

### What was tested

- **8 unit/integration tests (106 total)**: registrable-domain reduction (UK two-part suffixes), date and usage parsing, reseller id shapes; live client sends `Bearer base64(key)`, only ever GETs, treats a 404 mailbox endpoint as "no mailboxes", exposes no write method; demo sync mirrors 7/8/5 items, auto-links exact matches only, mailboxes inherit, `.com` sibling stays unlinked, re-sync is idempotent; suggestions by domain and name; two companies on one domain block auto-link; manual link cascades, unlink survives a sync; billing line must belong to the company and needs a linked item; company overview nests domains and mailboxes, shows the billing line, finds the invoice that mentions the domain and ignores the one that does not; reminders created once with the right priority, owner and company.
- **2 browser tests (20 total)**: 20i page shows demo state, auto-linked rows, the expiring filter, and an admin links an unmatched package; company Hosting tab nests the mailbox, an admin picks the billing line and it persists; read-only user sees the tab without controls and no connect form.

### Remaining dependencies (live verification)

- Connect the real reseller key on the VPS and run one sync; check the sync errors panel for any endpoint whose shape differs (usage and mailbox listing are the likely ones) and adjust the parser.
- SSL certificates (`kind = ssl`) are reserved but not fetched yet: the certificate listing endpoint shape was not verifiable from public material.

## Company record page redesign ✅

Built to the brief in the owner's redesign document: a compact company summary with horizontal section navigation, Activity as its own section, no timeline or logging form on Overview.

### What changed

- **Header**: 38px initials tile, company name (22px), email with the status badge and tags beside it, a small **Edit** button and an overflow menu (`⋯`, labelled "More actions") holding **Archive company** / **Restore company** behind the existing confirmation flow and `company.delete` permission. A slim metadata line shows owner, created date, website and phone.
- **Section navigation** (`src/components/company/section-nav.tsx`): real links (`?tab=…`, so deep links and the back button work) in the order Overview, Contacts, Sites, Opportunities, Proposals, Contracts, Invoices, Devices, Hosting, Tasks, Secure Vault (when the user may see it), Activity. Quiet count badges for non-zero counts only. When the row is too narrow, trailing sections move into a **More** menu (measured with a ResizeObserver) instead of wrapping; when the active section is inside the menu the trigger shows its name. Only the active section is rendered on the server.
- **Overview**: one bordered summary surface in three columns with subtle separators (stacked with horizontal dividers on mobile): company information (industry, company number, VAT number, custom fields) as label/value rows with muted dashes for blanks; the billing address as text; linked services (20i hosting names, NinjaOne device count, Xero invoice count, Secure Vault item count) linking to their sections, shown only when the data confirms the relationship. Internal notes below when present. A quiet footer with contact, site and task counts (open tasks in brackets) and **View activity →**.
- **Activity** (`src/components/company/activity-panel.tsx`): heading, **Log activity** button that reveals the existing NoteForm (same fields, validation, action and refresh), and compact rows (icon, title, details, timestamp and author right-aligned on desktop, stacked on small screens).
- All other sections keep their previous content and permissions.

### What was tested

- Browser suite (20 tests) updated to open sections through the navigation or the More menu (`tests/e2e/helpers.ts`), and Phase 1 now checks the creation event under Activity rather than on Overview.
- Screenshots at 1280, 900 and 390px: three columns side by side on desktop, More menu at tablet width with the active section identifiable, stacked summary and wrapped long company name on mobile, no horizontal overflow.

### Limitations

- The app has no dark mode yet (see backlog), so only the light palette was applied using the existing tokens.
- Count badges use the same definitions as before: open opportunities, active contracts, active devices, open tasks, unarchived vault items.

## Phase 9 — Two-factor authentication ✅

### What works

- **Authenticator app (TOTP) as a second factor**, using Better Auth's `twoFactor` plugin on the existing session model: 6 digits, 30 seconds, secret and recovery codes stored encrypted with `BETTER_AUTH_SECRET` in the new `two_factor` table; `user.two_factor_enabled` flips only after a code has been verified.
- **Enrolment** on the new **Security** page (shield icon in the header, `/account/security`): confirm password → QR code and manual key → verify one code → ten recovery codes shown once with copy and download. Also there: regenerate recovery codes (password), forget trusted browsers, turn off (password; signs out other sessions). Microsoft-only accounts see that Entra handles their MFA.
- **Sign-in**: after the password is accepted the server deletes the provisional session and sets a 10-minute challenge cookie; `/login/verify` takes the authenticator code or a recovery code, with **Trust this browser for 30 days**. Ten wrong codes lock the second factor for 15 minutes.
- **Policy** (Settings → Security): roles that must use 2FA and an optional grace-period end date. Before the date affected users see a banner; after it (or with no date) every page redirects them to enrolment. Only accounts with a CRM password are counted; the page lists each user's status.
- **Admin reset** (Settings → Users → *Reset 2FA*): removes the secret and codes, forgets trusted browsers, signs the user out everywhere, audited as `user.two_factor.reset`. Enable, disable, code regeneration and trusted-browser revocation are audited too.

### What was tested

- **3 unit/integration tests (109 total)**: policy rules (roles, password-less exemption, grace period before/after the date); full API flow — enable does not activate until a code is verified, wrong code refused, stored secret and codes are not plaintext, password-only sign-in then returns a challenge and creates no session, wrong code refused, valid code with trust creates the session and a trust record, a recovery code works once, revoking trusted browsers, admin reset clears everything and writes the audit row, sign-in is password-only again.
- **2 browser tests (22 total)**: technician enrols (wrong password and wrong code refused), is challenged at sign-in, uses a recovery code with browser trust, is not challenged while trusted, forgets the browser, the used recovery code is refused, admin resets and the technician signs in with the password alone; policy requiring technicians blocks an un-enrolled technician on every page, a grace period turns that into a banner, clearing the policy restores access.

### Remaining dependencies

- Set the policy under Settings → Security once everyone has an authenticator app; a grace period of two weeks is a sensible start.
- `TWO_FACTOR_ISSUER` (optional) sets the name shown in authenticator apps; defaults to "Snelson Server CRM".
- Later: passkeys, and accepting an authenticator code as the Secure Vault step-up instead of the password.

## Phase 10 — Customer notes ✅

### What works

- **Notes section** on every company (after Overview in the section navigation, with a count): standing information such as site access, escalation contacts and preferences, kept apart from the dated Activity timeline. Any number of notes per company, each with a title, a Markdown body and a **pin** flag; pinned notes are also rendered at the top of the Overview.
- **Editor**: dialog with a title, a pin checkbox, a plain textarea with a small toolbar (heading, bold, bullet list, link inserted at the cursor) and a **Preview** toggle that renders through the same code as the page.
- **Safe rendering** (`src/lib/markdown-lite.tsx`): a small in-house Markdown subset (headings, paragraphs, bullet and numbered lists, bold, italic, inline code, links limited to http(s)/mailto/tel, horizontal rule) that builds React elements directly, so a note can never inject HTML. No new dependency.
- **Traceability**: every save is audited (`note.create`, `note.update` with a field diff of title, body and pin, `note.pin`/`note.unpin`, `note.archive`/`note.restore`) and the timeline gets a line; each note shows *Edited … by …*.
- **Permissions**: readable by everyone who can read the company, editable with `company.write`. Archive is soft, with a *Show archived* toggle and restore.
- **Migration**: the old free-text *Internal notes* field becomes a pinned note titled "Internal notes" on each company that had one; the form field is gone, and free-text notes on CSV import become a pinned note too.

### What was tested

- **5 unit/integration tests (114 total)**: Markdown parsing (headings, paragraphs, lists, rules; a `<script>` tag stays text), link scheme filtering, excerpts; create/list order/counts, no-op update, audited field diff, pin, archive removes and un-pins, updating an archived note refused, restore, timeline lines; CSV-style notes become a pinned note.
- **1 browser test (23 total)**: account manager adds a note with every toolbar action and a raw script tag, previews it, pins it; it renders on Notes and Overview with the script shown as text and absent from the page source; edit, unpin, archive, show archived, restore; read-only user sees it without controls.

### Remaining dependencies

- None to deploy. Later: per-site and per-contact notes with the same component; notes in global search.

## Phase 11 — Dark mode ✅

### What works

- **Three-way preference** (System / Light / Dark) from the sun-moon button in the header, saved on the user record and in a `crm-theme` cookie. A new device without the cookie picks up the account preference on first load. "System" follows the operating system and reacts live when it changes.
- **No flash**: the root layout renders `data-theme` from the cookie for explicit choices and an inline script resolves "system" before first paint.
- **How the styling works**: instead of editing every colour class, `[data-theme="dark"]` in `globals.css` redefines the palette variables that Tailwind utilities point at (the slate scale, the brand scale, the status hues used by badges and alerts) plus four semantic tokens (`page`, `surface`, `fg`, `sidebar`). `bg-white` surfaces became `bg-surface`, dark filter pills became `bg-fg text-surface`, overlays use `bg-black/50`. The sidebar carries `data-theme="light"` so its own dark design is untouched in both modes. Native controls follow via `color-scheme`.
- **Print** forces the light palette.

### What was tested

- **1 browser test (24 total)**: default follows the OS (light → dark on media change), explicit Light overrides the OS and survives reload, explicit Dark survives reload and a fresh browser context via the account, cards are lighter than the page and body text is light, the sidebar keeps white text, print media renders a white page.
- Screenshot pass in dark: login, dashboard, company page, invoices, 20i integration page, a dialog.

### Remaining dependencies

- None. Any future component that hard-codes a hex colour should use the palette or the four semantic tokens so both themes keep working.

## Phase 12 — Pax8 subscriptions ✅

### Verified against vendor documentation

Public Pax8 Partner API reference (devx.pax8.com): OAuth 2.0 client-credentials at `login.pax8.com/oauth/token` with audience `api://p8p.client`, base URL `api.pax8.com/v1`, paged `GET /companies`, `/products`, `/subscriptions`, `/invoices` and `/invoices/{id}/items` with `{ content, page }` envelopes. Field names not shown publicly are parsed defensively and kept verbatim in `raw`; a live account check remains on the list below.

### What works

- **Connector** (`src/connectors/pax8/`): read-only live client (token exchange cached and refreshed on 401, page walking up to 200 per page, retries with backoff), and a demo adapter with seven customer companies, seven products, ten subscriptions and the last three partner invoices, aligned with the seed contracts.
- **Mirror** (`pax8_companies`, `pax8_products`, `pax8_subscriptions`, `pax8_invoice_items`): companies, the catalogue entries their subscriptions reference, every subscription with quantity, status, partner price, billing term and commitment end, and the charge lines of the last N partner invoices per customer; deleted-at-Pax8 marking; hourly `pax8.sync` plus *Sync now*.
- **Company linking**: automatic on an exact registrable-domain match (website or contact email domain) or an exact normalised name, one Pax8 company per CRM company; similar names are suggestions only; manual link/unlink from the mapping table; unlinks are remembered.
- **Line matching**: each subscription is matched to the contract line that bills it, in order: the line a person chose on the company's **Subscriptions** tab, the catalogue product SKU equal to the Pax8 SKU or vendor SKU, the product name (or line description) equal to the Pax8 product name.
- **Licence check**: contracted quantity vs licences held at Pax8 for every matched line, written to `billing_discrepancies` with `source = pax8` and reviewed with the same accept/dismiss flow as device discrepancies (device pages and the dashboard now filter on `source = ninjaone`). Runs inside every sync, after a manual link, and on *Re-check licences*.
- **Costs**: the Pax8 price is the partner cost; the Subscriptions tab shows the monthly unit cost, the margin per unit against the line's price, flags lines whose recorded cost differs, and *Use as cost* copies the Pax8 price onto the line (converted to the line's billing period, audited; the sell price is never touched). *What Pax8 charged for this customer* lists the mirrored invoice totals per customer.
- **Integrations page** card, per-provider page with stats (companies, linked, active subscriptions and licences, partner cost per month, open discrepancies), mapping table, open discrepancies, sync history and errors; Reports integration health includes Pax8; Overview shows *Licences · Pax8*.

### What was tested

- **8 unit/integration tests (122 total)**: term-to-months, date and commitment parsing, monthly unit cost; line matching precedence (manual > SKU > name, none); live client exchanges credentials with the Pax8 audience, sends the bearer token, walks two pages, treats a 404 items endpoint as empty, only ever GETs, exposes no write method; demo sync mirrors 7 companies / 9 billed subscriptions with the right licence total, links three companies by domain or name and leaves the similar-name one unlinked, raises +2 and −2 discrepancies for the seed contracts and nothing for NinjaOne, re-sync is idempotent; company overview matches by name, computes margin, flags the unbilled subscription and lists three invoices; suggestions by similar name, manual link cascades to subscriptions, a second Pax8 company on one CRM company is refused, unlink survives a sync and an auto-link pass; billing line must belong to the company, manual choice wins, cost mismatch flagged and applied (1.60 → 1.55) with audit; reviewing a licence discrepancy logs a licence event with source pax8 and the check resolves once counts match.
- **2 browser tests (26 total)**: Pax8 page shows demo state, auto-linked rows, a similar-name suggestion an admin links, and the +2 / −2 discrepancies; company Subscriptions tab shows the name-matched line, an admin links the unbilled subscription and it persists, *differs* appears and *Use as cost* applies 1.55, the Northern Freight tab shows its +2, and a read-only user sees the tab without controls and no connect form.

### Remaining dependencies (live verification)

- Connect a real Pax8 API client on the VPS and run one sync; check the sync errors panel for any endpoint whose shape differs (subscription `price` / `commitmentTerm` and invoice items are the likely ones) and adjust the parser.
- Decide whether Pax8 invoices should also be reconciled against Xero bills (not built; the per-customer charge view is read-only).
- Write actions (change a licence quantity from the CRM) stay on the backlog behind confirmation and audit.

## Phase 13 — IT helpdesk (stage 1 of 4: tickets, queues, conversation) ✅

The helpdesk is delivered in four stages, each its own pull request: **1** ticket data model, permissions and core interface (this section); **2** Microsoft 365 inbound and outbound e-mail with recovery and deduplication; **3** collaboration, SLAs, automation and reporting; **4** knowledge base, assets and production hardening. The customer portal is on the backlog.

### What works

- **Data model** (`src/db/schema/helpdesk.ts`, migration `0012_helpdesk_core.sql`): `tickets` (identity number → reference `IT-000123`, subject, description, status, priority, type, source, category and subcategory, tags, requester name/e-mail/contact with an *unverified* flag, company, assignee, team, needs-review flag, first-response/resolved/closed timestamps, SLA deadline columns for stage 3, resolution summary and category, merged-into and parent pointers, custom fields, optimistic-concurrency `version`, time total), `ticket_messages` (public or internal, channel e-mail/manual/note, direction, author or from/to/cc/bcc, text + Markdown + sanitised HTML + quoted part, automated flag, mailbox-scoped provider ids, Message-ID / In-Reply-To / References / conversation id, delivery status), `ticket_participants` (requester, cc, staff followers), `ticket_attachments` (metadata, scan status; bytes arrive in stage 2), `ticket_events` (append-only trail with actor type user/system/automation/email), `ticket_links` (related, parent, duplicate, merged_from, split_from), `ticket_time_entries`, `ticket_timers`, `ticket_drafts`, `helpdesk_teams` + members, `helpdesk_categories` (two levels). `activity_type` and `custom_field_entity` gain `ticket`.
- **Permissions** mapped onto existing roles: `helpdesk.read` (everyone: Read-only Staff), `helpdesk.agent` (technician, account manager, admin: Agent), `helpdesk.manage` (account manager, admin: Team Manager — bulk actions, assigning others, merge/split, team changes), `helpdesk.admin` (admin: Helpdesk Administrator — teams, categories, later mailbox/SLA/automation). Enforced in every server action; the UI only hides controls.
- **Helpdesk section** in the sidebar with Dashboard (open/unassigned/mine/overdue/awaiting/today, review-queue banner, my tickets, unassigned, recently updated, breakdowns by status, priority, agent and customer), **Tickets** queue with saved views (My tickets, Unassigned, All open, Awaiting customer, Awaiting third party, Overdue, Recently updated, Resolved, Needs review, All), search (reference, subject, requester, company, message text), filters (status, priority, type, assignee, team, category, company), sortable columns, pagination, a column chooser (kept in the URL so it can be saved as a view), and bulk assign / team / priority / status for managers with per-ticket error reporting.
- **Ticket page**: conversation with events interleaved (toggle), internal notes visually distinct and never rendered as customer-facing, a composer with draft auto-save per user (with a stale-draft warning when the ticket changed), *Internal note* vs *Log customer message* (phone / in person until the mailbox stage), optional status change in the same action, Ctrl+Enter; side panel with status (transition-checked, resolution summary required to resolve, reopen count), assignment (take/release; managers pick anyone), requester and company with contact link, category, tags, custom fields, CC participants, followers, time (manual entries and a start/stop timer), linked tickets (related, parent/child, duplicate), merge (preview of messages, time, new participants and a differing requester; sources close and point at the survivor so later replies to the old reference reach it) and split (chosen messages move to a new ticket for the same requester, linked back).
- **Status model**: New → Open → In progress ↔ Awaiting customer / Awaiting third party → Resolved → Closed, Cancelled; reopening from resolved/closed/cancelled goes to Open and clears resolution timestamps. Automated messages and internal notes never count as a first response; the first public agent message sets `first_response_at`.
- **Integration with the CRM**: tickets on the company page (Tickets tab + *Helpdesk* line in Linked services) and contact page, ticket events in the company timeline, tickets in global search (by reference or subject), custom fields for tickets under Settings → Tags & custom fields, a *Helpdesk* nav entry.
- **Administration**: teams with members and lead, two-level categories.

### What was tested

- **10 unit/integration tests (132 total)**: references and Markdown → text/HTML (script tags escaped, javascript: links refused), role mapping, transitions; creation from a contact with company link, initial message, event, timeline entry, lookup by reference and global search; e-mail matched to an existing contact vs unknown sender left unverified with no company inferred from the domain; transition rules, resolution summary required, timestamps and reopen count, stale version refused; field updates with audited diff, notes not counting as first response, public message setting first response and status, draft save/clear, time totals; views, filters, search by text and reference, sorting, counts; bulk actions reporting per-ticket failures; merge preview and execution (messages, cc, time, links, old reference resolves to the survivor, merged ticket refuses new messages) and split (messages move, links back, last message must stay); internal notes never carry recipients or delivery state.
- **2 browser tests (29 total)**: technician walks dashboard → queues (unassigned, awaiting customer, search, resolved; no bulk controls) → creates a ticket → takes it, adds a note, logs a customer message that changes status, resolves with a summary, logs time → sees it on the company Tickets tab; account manager bulk-assigns, merges with a preview and the merged reference disappears from the queue; read-only user sees tickets without controls and is refused the admin page.

### Remaining dependencies

- Stage 2 adds the mailbox: e-mail replies, attachments and HTML rendering (the composer's public message is a logged message until then).
- SLA deadlines are displayed when present but are only populated by stage 3's policies.

