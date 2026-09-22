# Integrations

This is the working capability matrix. Items marked **to confirm** must be checked against the live vendor documentation before that connector is written (Phases 3–5). Nothing is implemented against an endpoint that hasn't been confirmed.

## Capability matrix

| | Better Proposals | Xero | NinjaOne (EU) |
|---|---|---|---|
| **Plan / account** | API available on **Premium and Enterprise** plans only | Any Xero organisation; app registered in the developer portal | Any NinjaOne tenant; API client created by an admin |
| **Auth** | Static API token sent as a `Bptoken` header | OAuth 2.0 authorization-code. Access token 30 min; refresh token 60 days and **rotates on each refresh** (store the new one every time). Organisation selected by `xero-tenant-id` | OAuth 2.0. Machine-to-machine "API Services" client with `client_credentials` grant (**to confirm** — some docs list only auth-code/implicit) |
| **Base URL** | `https://api.betterproposals.io` | `https://api.xero.com/api.xro/2.0`; identity at `https://identity.xero.com` | `https://eu.ninjarmm.com/api/v2` (region chosen at connect time) |
| **Scopes** | n/a | `openid profile email offline_access accounting.contacts accounting.transactions accounting.settings.read` | `monitoring` only. Never `management` or `control` (read-only by design) |
| **Read** | Proposals by status (new/sent/opened/signed/paid), proposal detail, templates, currencies, companies (**to confirm** exact paths) | Contacts, Invoices, Payments, CreditNotes, Accounts, TaxRates, Currencies, Organisation | Organizations, Locations, Devices (`/devices-detailed`), device OS/health queries |
| **Write** | Create proposal from template with merge tags (`/proposal/create/`). Pushing line-item pricing: **to confirm** | Create Contact (draft), create Invoice with `Status=DRAFT`, using `Idempotency-Key` header | None |
| **Events** | No documented webhooks → **poll every 15 min** | Webhooks for Contacts and Invoices; HMAC-SHA256 signature, must reply within 5 s | No general-purpose webhooks in Public API → poll devices hourly, organisations daily |
| **Rate limits** | Not published → throttle ~1 req/s, back off on 429 | 60/min, 5,000/day, 5 concurrent per org per app; read `Retry-After` | Not published → back off on 429; page with `pageSize`/`after` |
| **Deep links** | Proposal URL from the API | `https://go.xero.com/...` invoice/contact links | Device and organisation pages in the NinjaOne console |
| **Cannot do via API → hand-off** | Sending, e-signature, editing content: "Open in Better Proposals" button | Approving, sending, allocating payments: stay in Xero | Remote commands, scripts, device deletion: stay in NinjaOne |

## Reliability rules (all connectors)

- Credentials entered in the app are encrypted (AES-256-GCM) before storage. OAuth app secrets live in `.env` only.
- All calls go through a shared HTTP client: pagination helper, timeout, `Retry-After` handling, jittered exponential backoff (max 5 attempts), per-connection circuit breaker.
- Every sync writes a `sync_runs` row (started, finished, counts, errors) visible on the Integrations page, with a "retry" button.
- Every outbound write is idempotent via `outbound_requests`; every inbound event is de-duplicated via `inbound_events`.
- Webhook endpoints verify the signature, store the raw event, enqueue a job and return 200 within the provider's deadline. Processing happens in the worker.
- Scheduled reconciliation (nightly) re-reads records changed since the last successful sync (`If-Modified-Since` for Xero) to recover missed events.

## Setup instructions

### Better Proposals

1. In Better Proposals: Settings → Integrations → API. Copy the API token (Premium/Enterprise plans).
2. In the CRM: Integrations → Better Proposals → paste the token → "Test connection". The CRM stores it encrypted.
3. Choose the templates you want available when creating proposals from an opportunity.
4. Polling runs every 15 minutes; "Sync now" forces a run.

### Xero

1. Create an app at <https://developer.xero.com/app/manage> (Web app). Redirect URI: `https://<your-domain>/api/integrations/xero/callback`.
2. Put `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` in `.env`. Register the webhook URL `https://<your-domain>/api/webhooks/xero` and put the signing key in `XERO_WEBHOOK_KEY`.
3. In the CRM: Integrations → Xero → "Connect". Sign in, consent, then **pick the organisation** if you have more than one. The CRM records the tenant id.
4. Map account codes and tax rates (Settings → Integrations → Xero) before preparing invoices.
5. Map customers on the mapping screen. Suggestions are made by company number/VAT/domain/name; each link needs a click to confirm.

### NinjaOne

1. NinjaOne console: Administration → Apps → API → Add. Type **API Services (machine-to-machine)**, scope **Monitoring** only.
2. Put the client id and secret in `.env` (`NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET`, `NINJAONE_REGION=eu`).
3. In the CRM: Integrations → NinjaOne → "Test connection", then map organisations to companies and locations to sites.
4. Devices sync hourly. The discrepancy check compares active devices (seen within the configured window, billable device types only) with per-device contract lines.

## Demo mode

With `DEMO_MODE=true` and no credentials for a provider, the CRM uses a demo adapter with synthetic data. The header shows a **DEMO MODE** badge, the Integrations page shows the provider as *Demo (not connected)*, and the demo adapters live in `src/connectors/<provider>/demo/`, separate from the live clients. Demo mode is refused when `NODE_ENV=production`.
