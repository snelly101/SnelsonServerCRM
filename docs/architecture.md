# Architecture

## Overview

```
Browser ──HTTPS──▶ Caddy ──▶ Next.js (web)
                                │  server actions + route handlers
                                │  every call: session → role → permission → zod → service
                                ▼
                            PostgreSQL ◀──── worker (pg-boss)
                                ▲              scheduled syncs, outbound writes,
                                │              webhook processing, reminders
                     /api/webhooks/* (Phase 4+)
                     verify signature → insert inbound_events → enqueue job → 200
```

One codebase, two processes (`web` and `worker`) sharing the same database. Nothing talks to an external API from the browser.

## Data model

### Identity and audit (Phase 1)

| Table | Purpose |
|---|---|
| `user`, `session`, `account`, `verification` | Better Auth core tables. `user.role` (enum) and `user.active` are app-owned. Local passwords live in `account` with `provider_id = 'credential'`. |
| `audit_log` | Append-only. Actor, action (`company.update`), entity, field-level diff, IP. Credential-looking keys are scrubbed before insert. |
| `app_settings` | Single row: company name, currency, date format, timezone, tax label/rate, device-active window. |

### Customers (Phase 1)

| Table | Notes |
|---|---|
| `companies` | Prospect/customer/former. `normalized_name` and `domain` are derived on write and drive duplicate detection. `custom_fields` is JSONB validated against `custom_field_defs`. Archive = `archived_at`, never hard delete. |
| `sites` | Physical locations; one may be primary. NinjaOne locations map here (Phase 5). |
| `contacts` | Belong to a company, optionally a site. `roles` is an array (`decision_maker`, `technical`, `billing`, `primary`, `other`). `normalized_email` is unique-checked in code. |
| `tags`, `company_tags` | Free-form tags with colours. |
| `custom_field_defs` | Typed definitions (text/number/date/boolean/select) per entity. |
| `activities` | The customer timeline. Notes, calls, meetings, system events and (later) proposal/invoice/device/sync events. Append-only. |
| `saved_views` | Named URL-param snapshots per list page, per user, optionally shared. |

### Planned (Phases 2–5)

- **Sales:** `pipelines`, `stages`, `opportunities`, `opportunity_lines` (revenue type: recurring / one_off_project / hardware; cost nullable → margin marked "estimated").
- **Catalogue and contracts:** `products` (pricing model per_user / per_device / fixed / one_off), `contracts`, `contract_lines` (contracted quantity), `contract_reviews`.
- **Work:** `tasks`, `checklist_templates`, `checklist_template_items`, `onboardings` (unique on `proposal_id` → created exactly once), `onboarding_items`.
- **Integration plumbing:** `integration_connections` (encrypted credentials, chosen Xero tenant, status, last sync), `external_links` (provider, entity type, local id ↔ external id, unique both ways, how it was matched), `sync_runs`, `sync_errors`, `inbound_events` (unique provider+event id), `outbound_requests` (unique idempotency key + state machine), `mapping_conflicts`.
- **Mirrored external data:** `bp_proposals`, `xero_invoices`, `xero_payments`, `ninja_devices`, each with `fetched_at` and `source_updated_at` so the UI can label rows live / cached / stale / unavailable.
- **Review queue:** `billing_discrepancies` (contracted vs observed quantity, open / accepted / dismissed / resolved).

## Request flow

1. `middleware.ts` redirects to `/login` when there is no session cookie (fast path only).
2. Pages call `requireUser()` / `requirePermission(action)` (`src/lib/session.ts`). The role is read from the database on every request and cached per request with React `cache()`.
3. Server actions (`src/actions/*`) run inside `runAction()`, which turns zod errors into field errors and `ForbiddenError` into a readable message. They call `requireActionPermission(action)` first, parse with zod, then call a service.
4. Services (`src/services/*`) contain the logic, run in transactions, write `audit_log` and `activities`. They are what the tests exercise directly.

## Duplicate detection

`findDuplicateCompanies()` scores candidates by:

| Match | Confidence |
|---|---|
| Same company number or VAT number | high |
| Same email/website domain (free-mail domains ignored) | high |
| Same normalised name (legal suffixes and punctuation stripped) | medium |
| Trigram similarity > 0.6 on normalised name | low |

High-confidence matches block creation unless the user ticks "create anyway". CSV import skips high and medium matches and reports them. Nothing is ever merged automatically, and name similarity alone never blocks.

## Background jobs

pg-boss stores jobs in the `pgboss` schema of the same database. Handlers are registered in `src/worker/jobs.ts` and must be idempotent (at-least-once delivery). Two ways to run them:

- **`npm run worker`** — long-lived process (VPS/Docker). Default.
- **`npm run jobs:tick`** — runs for ~50 s and exits. For shared hosts: schedule it from cron every minute. Because the queue is in Postgres, missed or overlapping ticks are harmless.

Retries: per-queue `retryLimit` with exponential backoff (`retryBackoff: true`). Integration queues (Phase 3+) also honour `Retry-After` from 429 responses and open a circuit breaker per connection after repeated failures.

## Integration design (applies to all three)

- **Connector interface:** each provider implements `listX(cursor)`, `getX(id)`, `createX(payload, idempotencyKey)`. `connectors/<provider>/live/` is the real client; `connectors/<provider>/demo/` returns synthetic data and is only selectable when `DEMO_MODE=true`. The UI shows a DEMO banner and a demo connection can never display as "connected" or "verified".
- **Outbound idempotency:** every write first inserts an `outbound_requests` row keyed by a deterministic idempotency key (e.g. `bp:create:{opportunityId}:{version}`, `xero:invoice:{draftId}`). Retries reuse the row. An in-flight row is settled by looking the record up at the provider by our reference before any second attempt.
- **Inbound idempotency:** webhooks and poll results insert into `inbound_events` with a unique `(provider, event_id)`; duplicates are dropped before processing.
- **Field ownership (Xero contacts):** Xero owns legal name, billing address, tax number and balances. The CRM owns owner, tags, trading name, sites and contact roles. Email/phone are CRM-owned but only pushed on an explicit "push to Xero" action. Concurrent edits raise a `mapping_conflicts` row for review; nothing is overwritten silently.
- **Matching:** external records are suggested by company number, VAT number, domain and normalised name, but a link is only created when a person confirms it on the mapping screen.
- **Deleted/archived externally:** the local mirror row is marked `external_status = 'archived'`, the link is kept, and the change appears on the Integrations page. Local data is never deleted by a sync.
- **Freshness:** mirrored rows carry `fetched_at`. UI labels: *live* (fetched this request), *cached* (< 1 h), *stale* (older than the provider's sync interval × 3), *unavailable* (connection failed or field not exposed by the API).

## MRR definition (Phase 2 reporting)

MRR = Σ over active contracts, over recurring lines: `unit_price × contracted_quantity`, normalised to monthly (annual ÷ 12, quarterly ÷ 3, monthly × 1). One-off and hardware lines are excluded and reported separately. The formula is printed on the report page.
