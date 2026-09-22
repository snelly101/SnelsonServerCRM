# Integrations

All three vendors were verified against primary sources on 22 Sep 2026: the Better Proposals API documentation and its published example request/response scripts, Xero's official OpenAPI specifications (`xero_accounting.yaml`, `xero-webhooks.yaml`), and NinjaOne's OpenAPI YAML (`/apidocs-beta/NinjaRMM-API-v2.yaml`) plus its OAuth configuration article. Live endpoints were probed unauthenticated to confirm hosts and error shapes.

## Capability matrix (verified)

| | Better Proposals | Xero | NinjaOne (EU) |
|---|---|---|---|
| **Plan / account** | API only on **Premium and Enterprise** (trial allowed; other plans return "It isn't possible to use the Better Proposals API on your current plan") | Any Xero organisation; app registered in the developer portal | Any tenant; system administrator creates the API client |
| **Auth** | Static token, header `Bptoken: <token>`. Generated at Settings → Integrations → API. Invalid token → HTTP 401 `{"status":"error","message":"Invalid token"}`; missing → 400 "Malformed request" | OAuth 2.0 authorization-code at `https://identity.xero.com/connect/token`. Access token 30 min; refresh token 60 days, rotates on every refresh. Organisation chosen via `xero-tenant-id` header | OAuth 2.0 at `https://eu.ninjarmm.com/ws/oauth/token`. "API Services (machine-to-machine)" client → `client_credentials` grant (the OAuth article lists this for API Services apps; its intro sentence mentioning only auth-code/implicit is outdated). Bearer token on requests |
| **Base URL** | `https://api.betterproposals.io` | `https://api.xero.com/api.xro/2.0` | `https://eu.ninjarmm.com/api/v2` (region from the client's instance: app/us2/eu/ca/oc) |
| **Scopes** | n/a | `openid profile email offline_access accounting.contacts accounting.transactions accounting.settings.read` | `monitoring` only (read-only). Never `management` (writes, scripts) or `control` (remote access) |
| **Read** | `GET /proposal`, `/proposal/{new,sent,opened,signed,paid}`, `/proposal/:id`, `/proposal/count`, `/template`, `/template/:id`, `/company`, `/company/:id`, `/quote`, `/quote/:id`, `/doctype`, `/currency`, `/settings`, `/settings/brand`, `/settings/merge_tag`. Pagination `page`/`per_page`. Fields include `Signed`, `DateSigned`, `SignedSignature`, `ProposalOpened`, `DateSent`, `OneOffTotal`, `MonthlyTotal`, `QuarterlyTotal`, `AnnualTotal`, `ProposalView`, `Preview`, `Contacts[]`, `CompanyCRMID`, `CRMOpportunityID` | `GET /Contacts` (`where`, `IDs`, `page`, `searchTerm`, `If-Modified-Since`), `/Invoices` (`Statuses`, `ContactIDs`, `page`), `/Invoices/{id}`, `/Payments`, `/Accounts`, `/TaxRates`, `/Currencies`, `/Organisation`, `/BrandingThemes`, `/Invoices/{id}/OnlineInvoice` | `GET /v2/organizations` (`pageSize`,`after`), `/v2/organizations-detailed`, `/v2/organization/{id}/locations`, `/v2/organization/{id}/devices`, `/v2/devices-detailed` (`df` filter, `pageSize`, `after`), `/v2/device/{id}`, `/v2/queries/device-health` (`cursor`), `/v2/queries/operating-systems`, `/v2/queries/antivirus-status`. Device fields: `id`, `organizationId`, `locationId`, `nodeClass` (WINDOWS_WORKSTATION, WINDOWS_SERVER, MAC, LINUX_*, VMWARE_*, NMS_*…), `displayName`, `systemName`, `offline`, `lastContact`, `lastUpdate`, `approvalStatus`. Health: `healthStatus`, patch/threat/alert counts, `avInstallStatus` |
| **Write** | `POST /proposal/create` (form-encoded): `Company` (id **or name → creates**), `Template`, `Cover`, `DocumentType`, `Brand`, `Currency`, `Tax`, `TaxLabel`, `TaxAmount`, `Contacts[]{FirstName,Surname,Email,Signature}`, `MergeTags` (JSON string). `POST /company/create`, `/quote/create` (`CompanyID`, `templateID` — amount comes from the template), `/doctype/create`, `/proposal/cover/create`. **No line-item pricing** on any documented endpoint | `PUT /Contacts`, `PUT /Invoices` with `Status: DRAFT`, `Idempotency-Key` header (128 chars max). `POST /Invoices/{id}` to update a draft. Never `AUTHORISED` from the CRM | **None** (read-only integration by design) |
| **Events** | **No webhooks documented** → poll every 15 min (`*/15 * * * *`), singleton job, plus "Sync now" | Webhooks for `CONTACT` and `INVOICE` (`CREATE`/`UPDATE`); payload `{events[], firstEventSequence, lastEventSequence, entropy}`; HMAC-SHA256 of the raw body with the webhook key, base64, in `x-xero-signature`; respond 200 within 5 s, 401 on bad signature. Nightly reconciliation with `If-Modified-Since` | No general webhooks in the Public API → poll devices hourly, organisations/locations daily |
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

## Xero (Phase 4)

See the matrix above. Setup, field ownership and invoice approval flow are documented when the connector lands.

## NinjaOne (Phase 5)

See the matrix above. The connector will use `client_credentials` with the `monitoring` scope against the EU instance and stay read-only.
