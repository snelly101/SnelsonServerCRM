# Integrations

All three vendors were verified against primary sources on 22 Sep 2026: the Better Proposals API documentation and its published example request/response scripts, Xero's official OpenAPI specifications (`xero_accounting.yaml`, `xero-webhooks.yaml`), and NinjaOne's OpenAPI YAML (`/apidocs-beta/NinjaRMM-API-v2.yaml`) plus its OAuth configuration article. Live endpoints were probed unauthenticated to confirm hosts and error shapes.

## Capability matrix (verified)

| | Better Proposals | Xero | NinjaOne (EU) |
|---|---|---|---|
| **Plan / account** | API only on **Premium and Enterprise** (trial allowed; other plans return "It isn't possible to use the Better Proposals API on your current plan") | Any Xero organisation; app registered in the developer portal | Any tenant; system administrator creates the API client |
| **Auth** | Static token, header `Bptoken: <token>`. Generated at Settings → Integrations → API. Invalid token → HTTP 401 `{"status":"error","message":"Invalid token"}`; missing → 400 "Malformed request" | OAuth 2.0 authorization-code at `https://identity.xero.com/connect/token`. Access token 30 min; refresh token 60 days, rotates on every refresh. Organisation chosen via `xero-tenant-id` header | OAuth 2.0 at `https://eu.ninjarmm.com/ws/oauth/token`. "API Services (machine-to-machine)" client → `client_credentials` grant (the OAuth article lists this for API Services apps; its intro sentence mentioning only auth-code/implicit is outdated). Bearer token on requests |
| **Base URL** | `https://api.betterproposals.io` | `https://api.xero.com/api.xro/2.0` | `https://eu.ninjarmm.com/api/v2` (region from the client's instance: app/us2/eu/ca/oc) |
| **Scopes** | n/a | `openid profile email offline_access accounting.contacts accounting.invoices accounting.payments.read accounting.settings.read` (granular scopes; `accounting.transactions` is refused for apps created on or after 2 March 2026) | `monitoring` only (read-only). Never `management` (writes, scripts) or `control` (remote access) |
| **Read** | `GET /proposal`, `/proposal/{new,sent,opened,signed,paid}`, `/proposal/:id`, `/proposal/count`, `/template`, `/template/:id`, `/company`, `/company/:id`, `/quote`, `/quote/:id`, `/doctype`, `/currency`, `/settings`, `/settings/brand`, `/settings/merge_tag`. Pagination `page`/`per_page`. Fields include `Signed`, `DateSigned`, `SignedSignature`, `ProposalOpened`, `DateSent`, `OneOffTotal`, `MonthlyTotal`, `QuarterlyTotal`, `AnnualTotal`, `ProposalView`, `Preview`, `Contacts[]`, `CompanyCRMID`, `CRMOpportunityID` | `GET /Contacts` (`where`, `IDs`, `page`, `searchTerm`, `If-Modified-Since`), `/Invoices` (`Statuses`, `ContactIDs`, `page`), `/Invoices/{id}`, `/Payments`, `/Accounts`, `/TaxRates`, `/Currencies`, `/Organisation`, `/BrandingThemes`, `/Invoices/{id}/OnlineInvoice` | `GET /v2/organizations` (`pageSize`,`after`), `/v2/organizations-detailed`, `/v2/organization/{id}/locations`, `/v2/organization/{id}/devices`, `/v2/devices-detailed` (`df` filter, `pageSize`, `after`), `/v2/device/{id}`, `/v2/queries/device-health` (`cursor`), `/v2/queries/operating-systems`, `/v2/queries/antivirus-status`. Device fields: `id`, `organizationId`, `locationId`, `nodeClass` (WINDOWS_WORKSTATION, WINDOWS_SERVER, MAC, LINUX_*, VMWARE_*, NMS_*…), `displayName`, `systemName`, `offline`, `lastContact`, `lastUpdate`, `approvalStatus`. Health: `healthStatus`, patch/threat/alert counts, `avInstallStatus` |
| **Write** | `POST /proposal/create` (form-encoded): `Company` (id **or name → creates**), `Template`, `Cover`, `DocumentType`, `Brand`, `Currency`, `Tax`, `TaxLabel`, `TaxAmount`, `Contacts[]{FirstName,Surname,Email,Signature}`, `MergeTags` (JSON string). `POST /company/create`, `/quote/create` (`CompanyID`, `templateID` — amount comes from the template), `/doctype/create`, `/proposal/cover/create`. **No line-item pricing** on any documented endpoint | `PUT /Contacts`, `PUT /Invoices` with `Status: DRAFT`, `Idempotency-Key` header (128 chars max). `POST /Invoices/{id}` to update a draft. Never `AUTHORISED` from the CRM | **None** (read-only integration by design) |
| **Events** | **No webhooks documented** → poll every 15 min (`*/15 * * * *`), singleton job, plus "Sync now" | Webhooks for `CONTACT` and `INVOICE` (`CREATE`/`UPDATE`); payload `{events[], firstEventSequence, lastEventSequence, entropy}`; HMAC-SHA256 of the raw body with the webhook key, base64, in `x-xero-signature`; respond 200 within 5 s, 401 on bad signature. Nightly reconciliation with `If-Modified-Since` | No general webhooks in the Public API → poll organisations, locations, devices and health hourly (`ninjaone.sync`) |
| **Rate limits** | Not published → 250 ms minimum spacing, back off on 429 | 60 calls/min, 5,000/day, 5 concurrent, per org per app. `Retry-After` on 429; `X-MinLimit-Remaining`, `X-DayLimit-Remaining` headers | Not published → back off on 429 |
| **Deep links** | `ProposalView` (app), `Preview` (customer view), per-contact `Link` | Invoice `OnlineInvoice` URL; `https://go.xero.com/...` for contacts/invoices | Device and organisation pages in the NinjaOne console |
| **Hand-off (cannot do via API)** | Pricing tables, editing content, sending, e-signature → "Open in Better Proposals" | Approving, sending, allocating payments → stay in Xero | Remote commands, scripts, device deletion → stay in NinjaOne |

## Reliability rules (all connectors)

- Credentials entered in the app are AES-256-GCM encrypted (`APP_ENCRYPTION_KEY`) before storage; OAuth *app* secrets live in `.env`. Decrypted values never reach a page component or a log line (pino redaction).
- Every call goes through `HttpClient` (`src/lib/integrations/http.ts`): timeout, jittered exponential backoff up to 5 attempts on 429/5xx/network errors, `Retry-After` honoured, 4xx never retried, per-client minimum spacing, one-shot token refresh hook on 401.
- Every sync writes a `sync_runs` row (trigger, counts, message) and per-record `sync_errors`; both are shown on the Integrations page with links.
- Circuit breaker: three consecutive failed runs pause *scheduled* syncs for 5 min, doubling to a cap of 4 h; manual "Sync now" still works; any success resets it. Auth-shaped errors (401/403/"Invalid token") set the connection to **expired**.
- Outbound writes go through `runOutbound(provider, idempotencyKey, …)`: one row per logical write; a succeeded key returns the stored external id without calling the provider; a failed key reconciles at the provider (search by our reference) before trying again; an in-flight key blocks a second caller.
- Inbound events (webhook deliveries and polled status transitions) are unique on `(provider, event_id)` and processed once.
- Links between CRM and external records are unique in both directions. Suggestions are made by company/VAT number, domain and normalised name; a link is created only by a person, or by the CRM for records it created itself. A name match alone becomes a "needs review" item, never a link.
- External records that disappear or are archived keep their link with `external_status = archived`; nothing local is deleted by a sync.
- Data freshness in the UI: mirrored rows show *cached* with their `fetched_at`, and *stale* once older than three poll intervals; fields the API does not expose are shown as *unavailable*.

## Better Proposals (Phase 3, built)

**Setup**

1. Better Proposals → Settings → Integrations → API → *Generate API Key* (Premium/Enterprise).
2. CRM → Integrations → Better Proposals → paste the token → *Verify and save*. The CRM calls `/settings` and `/settings/brand` to verify it, then stores it encrypted and records the account name and tax defaults.
3. Choose a default template. Templates are read live from `/template`.
4. The worker polls every 15 minutes; use *Sync now* to refresh immediately.

**Workflow**

- On an open opportunity, *Create proposal* → choose template, recipients (first is the signer) and values for the account's custom merge tags → the CRM creates the Better Proposals company if the CRM company isn't linked yet (reconciling by normalised name on retry), then `POST /proposal/create`. Idempotency key `bp:proposal:<opportunityId>:<version>`; "Create another version" increments the version.
- The proposal is mirrored (`bp_proposals`) with `ProposalView`/`Preview` links and shown on the opportunity, the company's Proposals tab, and the Proposals page. Pricing tables, sending and signing are done in Better Proposals via *Open in Better Proposals*.
- Polling overlays `/proposal` with `/proposal/opened|signed|paid` and records each status transition once as an inbound event → timeline entry.
- On **signed** (or paid): `processAcceptance` runs once per proposal — opportunity marked won, company promoted to customer, onboarding created with source key `proposal:<id>`, contract drafted from the opportunity's lines and stamped with the proposal id. Re-polls and re-runs are no-ops.
- Signed proposals with no linked opportunity, or proposals whose company name matches a CRM company but is not linked, become **Needs review** items on the Integrations page; link them from the Proposals page (linking a signed one runs acceptance immediately).

**Demo mode:** with `DEMO_MODE=true` (set it to `false` in production `.env`) and no token, a demo adapter (`src/connectors/betterproposals/demo.ts`) supplies synthetic proposals and advances them on request in tests. The UI labels it *Demo (not connected)* everywhere and `testConnection` never reports success.

## Xero (Phase 4, built)

**Setup**

1. developer.xero.com → *New app* (Web app). Redirect URI: `https://<domain>/api/integrations/xero/callback`. Copy the client id and secret into `.env` as `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` and restart. (These are the only Xero values outside the app: Xero checks the redirect URI against the registration, so they must exist before the first connect.)
2. In the app: Webhooks → add `https://<domain>/api/webhooks/xero`, tick Contacts and Invoices, copy the key into `XERO_WEBHOOK_KEY`. Xero's "intent to receive" check succeeds once the endpoint returns 401 for a bad signature and 200 for a good one.
3. CRM → Integrations → Xero → *Connect to Xero* → sign in and consent → **choose the organisation** (the CRM lists every authorised tenant and never assumes).
4. Choose invoice defaults (sales account code, hardware account code, tax rate, payment terms, branding theme — all read from Xero).
5. Map customers: accept a suggestion, search, or *Create in Xero*.

**Workflow and policies**

- Sync: hourly incremental (`If-Modified-Since` with a 10-minute overlap) for contacts, ACCREC invoices and payments; nightly full reconciliation; webhook events applied within a minute. Manual *Sync now* / *Full reconciliation* buttons.
- Field ownership: Xero owns legal name, addresses, tax number, balances, invoice status, payments. CRM owns owner, tags, sites, contact roles, opportunities, contracts. Email/phone: pushed only by explicit *Push*, refused with a review item when Xero changed first.
- Invoices: prepared from a contract period or a won opportunity → reviewed and edited → approved by `finance`/`admin` → created in Xero as **DRAFT** with `Reference = CRM-<id>`, `Idempotency-Key`, and an outbound-ledger row; retries reconcile by reference. Approving, sending and payments stay in Xero. Invoice `Url` links back to the CRM draft.
- Deleted/archived: archived Xero contacts keep their link (`external_status = archived`) and raise a review item; nothing local is deleted.
- Demo: with `DEMO_MODE=true` and no tokens, an in-memory organisation with customers, invoices and payments is used and labelled *Demo (not connected)*.

## NinjaOne (Phase 5, built)

**Read-only by design.** The live client (`src/connectors/ninjaone/live.ts`) has no write methods; only the `monitoring` scope is requested.

### Setup (all in the web UI)

1. NinjaOne → Administration → Apps → API → *Client app IDs* → Add. Application platform **API Services (machine-to-machine)**, scope **Monitoring** only, any redirect URI (unused).
2. CRM → Integrations → NinjaOne → choose the region (EU = `eu.ninjarmm.com`), paste the client id and secret → *Verify and connect*. The CRM requests a token with `grant_type=client_credentials&scope=monitoring` and only stores the credentials (encrypted) if that succeeds.
3. *Sync now*, then link organisations to companies and locations to sites in the mapping table. Nothing is linked automatically.

### What is mirrored

| Endpoint | Used for | Paging |
|---|---|---|
| `GET /v2/organizations` | organisations → `ninja_organizations` | `pageSize`/`after` |
| `GET /v2/organization/{id}/locations` | locations → `ninja_locations` | — |
| `GET /v2/devices-detailed` | devices (name, class, OS, last contact, approval, IPs) → `ninja_devices` | `pageSize`/`after` |
| `GET /v2/queries/device-health` | health status, patch/threat/alert counts | `cursor` |

Schedule: `ninjaone.sync` hourly at :20 (worker) plus *Sync now*. Deleted organisations/devices are marked `deleted`, never removed. Timestamps are epoch seconds. Requests are spaced 200 ms apart and back off on 429/5xx; a 401 triggers one token re-fetch.

### Counting and discrepancies

- **Active** = `lastContact` within *Settings → General → Device active window* (default 30 days).
- **Billable** = active **and** `nodeClass` in the configured list (default workstations, servers, VM guests) **and** (`approvalStatus = APPROVED` when "approved only" is on).
- Each contract line with *Compare with NinjaOne* is compared with the billable count at the linked organisation, or at the linked location when the line names a site (unlinked site → skipped). Differences become review items (open → accepted / dismissed / resolved) on the Devices page, the company's Devices tab and the contract. Accepting or dismissing is audited; contracts and invoices are never changed by the CRM.

### Importing existing data

- **Xero customers → companies** (Xero page, *Xero customers not yet in the CRM*): creates a customer company from the contact (address, VAT/company number, email, phone, billing contact) and links it; links an obvious existing company (company number, VAT, email domain or exact name) instead of duplicating.
- **Xero repeating invoices → draft contracts** (Xero page, *Repeating invoices in Xero*): one recurring contract line per template line, tax-exclusive, frequency from the schedule (monthly / every 3 months / every 12 months; weekly and other periods are listed but skipped), catalogue products matched by item code = SKU (sets pricing model, cost and device-count comparison); an item code with no product creates one from the Xero item (`GET /Items`: name, sale price, purchase price as cost; pricing model and category guessed from the wording, per-device products flagged for NinjaOne comparison), start/end dates from the schedule. The contract is created as **draft** and linked to the template id so re-running never duplicates. A person reviews and activates it.
- **NinjaOne organisations → companies** (NinjaOne page): same duplicate rules as the Xero import; devices are attached on link.

### Not available via the API (hand-off)

Remote control, scripts, reboots, device deletion, approving pending devices → done in the NinjaOne console. Device rows and company tabs deep-link to `https://<instance>/#/deviceDashboard/{id}/overview` and `customerDashboard/{orgId}`.
