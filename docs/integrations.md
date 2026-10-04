# Integrations

All vendors were verified against primary sources on 22 Sep 2026: the Better Proposals API documentation and its published example request/response scripts, Xero's official OpenAPI specifications (`xero_accounting.yaml`, `xero-webhooks.yaml`), and NinjaOne's OpenAPI YAML (`/apidocs-beta/NinjaRMM-API-v2.yaml`) plus its OAuth configuration article. Live endpoints were probed unauthenticated to confirm hosts and error shapes.

## Capability matrix (verified)

| | Better Proposals | Xero | NinjaOne (EU) |
|---|---|---|---|
| **Plan / account** | API only on **Premium and Enterprise** (trial allowed; other plans return "It isn't possible to use the Better Proposals API on your current plan") | Any Xero organisation; app registered in the developer portal | Any tenant; system administrator creates the API client |
| **Auth** | Static token, header `Bptoken: <token>`. Generated at Settings → Integrations → API. Invalid token → HTTP 401 `{"status":"error","message":"Invalid token"}`; missing → 400 "Malformed request" | OAuth 2.0 authorization-code at `https://identity.xero.com/connect/token`. Access token 30 min; refresh token 60 days, rotates on every refresh. Organisation chosen via `xero-tenant-id` header | OAuth 2.0 at `https://eu.ninjarmm.com/ws/oauth/token`. "API Services (machine-to-machine)" client → `client_credentials` grant (the OAuth article lists this for API Services apps; its intro sentence mentioning only auth-code/implicit is outdated). Bearer token on requests |
| **Base URL** | `https://api.betterproposals.io` | `https://api.xero.com/api.xro/2.0` | `https://eu.ninjarmm.com/api/v2` (region from the client's instance: app/us2/eu/ca/oc) |
| **Scopes** | n/a | `openid profile email offline_access accounting.contacts accounting.invoices accounting.payments.read accounting.settings.read` (granular scopes; `accounting.transactions` is refused for apps created on or after 2 March 2026) | `monitoring` (read-only) by default; `monitoring management` only when "Allow the CRM to create organisations" is ticked at connect time. Never `control` (remote access) |
| **Read** | `GET /proposal`, `/proposal/{new,sent,opened,signed,paid}`, `/proposal/:id`, `/proposal/count`, `/template`, `/template/:id`, `/company`, `/company/:id`, `/quote`, `/quote/:id`, `/doctype`, `/currency`, `/settings`, `/settings/brand`, `/settings/merge_tag`. Pagination `page`/`per_page`. Fields include `Signed`, `DateSigned`, `SignedSignature`, `ProposalOpened`, `DateSent`, `OneOffTotal`, `MonthlyTotal`, `QuarterlyTotal`, `AnnualTotal`, `ProposalView`, `Preview`, `Contacts[]`, `CompanyCRMID`, `CRMOpportunityID` | `GET /Contacts` (`where`, `IDs`, `page`, `searchTerm`, `If-Modified-Since`), `/Invoices` (`Statuses`, `ContactIDs`, `page`), `/Invoices/{id}`, `/Payments`, `/Accounts`, `/TaxRates`, `/Currencies`, `/Organisation`, `/BrandingThemes`, `/Invoices/{id}/OnlineInvoice` | `GET /v2/organizations` (`pageSize`,`after`), `/v2/organizations-detailed`, `/v2/organization/{id}/locations`, `/v2/organization/{id}/devices`, `/v2/devices-detailed` (`df` filter, `pageSize`, `after`), `/v2/device/{id}`, `/v2/queries/device-health` (`cursor`), `/v2/queries/operating-systems`, `/v2/queries/antivirus-status`. Device fields: `id`, `organizationId`, `locationId`, `nodeClass` (WINDOWS_WORKSTATION, WINDOWS_SERVER, MAC, LINUX_*, VMWARE_*, NMS_*…), `displayName`, `systemName`, `offline`, `lastContact`, `lastUpdate`, `approvalStatus`. Health: `healthStatus`, patch/threat/alert counts, `avInstallStatus` |
| **Write** | `POST /proposal/create` (form-encoded): `Company` (id **or name → creates**), `Template`, `Cover`, `DocumentType`, `Brand`, `Currency`, `Tax`, `TaxLabel`, `TaxAmount`, `Contacts[]{FirstName,Surname,Email,Signature}`, `MergeTags` (JSON string). `POST /company/create`, `/quote/create` (`CompanyID`, `templateID` — amount comes from the template), `/doctype/create`, `/proposal/cover/create`. **No line-item pricing** on any documented endpoint | `PUT /Contacts`, `PUT /Invoices` with `Status: DRAFT`, `Idempotency-Key` header (128 chars max). `POST /Invoices/{id}` to update a draft. Never `AUTHORISED` from the CRM | `POST /v2/organizations` (name + one location) and nothing else, only for the opt-in "create an organisation when a company becomes a customer" setting |
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

- Companies: `ensureBpCompanyForCompany` gives a CRM company its Better Proposals counterpart: an existing link, else a Better Proposals company with the same normalised name (linked `auto_confirmed`; if that one is already linked to another CRM company a review item is raised instead), else `POST /company/create` (name is the only field the API takes) linked `created_by_crm`, idempotent through `bp:company:<companyId>`. Runs on proposal creation, from *Push to Better Proposals* on the company's Proposals tab, and automatically for every new company (and for older companies when they become customers) when *Create a Better Proposals company automatically* is ticked under Integrations → Better Proposals → Defaults (off by default).
- Contacts: the API has no contact endpoint, so contacts are never pushed on their own; they are sent as recipients (`Contacts[]`) with each proposal.
- On an open opportunity, *Create proposal* → choose template, recipients (first is the signer) and values for the account's custom merge tags → the CRM resolves the Better Proposals company as above, then `POST /proposal/create`. Idempotency key `bp:proposal:<opportunityId>:<version>`; "Create another version" increments the version.
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
- Auto-create (optional, off by default; Integrations → Xero → defaults): when a company is created as, or changes to, *customer* (including an opportunity being won), a Xero contact is created and linked if Xero has no likely match. If a likely match exists, nothing is created and a review item asks you to link it instead. Failures are logged on the company timeline and never block the CRM change.
- Pro-rating (`src/lib/billing.ts`, shared by the billing run and *Prepare invoice*): a contract's **billing day** (1–28, optional) anchors periods to that day of the month; a start part-way through a period bills a single pro-rata line for the stub (quantity × per-period price × days ÷ days in the whole period), as does an end date inside a period. Changes on an active contract are dated history (`contract_line_changes`: value before and after, effective day, actor, reason, the draft that first accounted for them): a period is charged at the quantity on its first day, each increase inside it is added for its own days, decreases apply from the next period, price changes from the next period starting on or after the effective day; a change inside a period already invoiced is caught up on the next invoice as the difference between what that period should have cost and what its draft billed for the line. Cancelling a draft hands its changes back. Every engine-produced line carries its calculation inputs (`calc`), shown on the draft page.
- Findings (Finance → *Findings*, `finance.read`; `src/services/billing-findings.ts`): one list of what needs a decision across the register, the billing run, the drafts, Xero and the Pax8 reconciliation (unmapped services, overdue free reviews, covered services whose line cannot charge, expected charges not drafted, drafts waiting over a week, invoices changed in Xero, supplier charge differences and unallocated supplier charges, sales invoices raised outside the CRM), each linking to where it is resolved. Read-only.
- Renewals (Contracts → *Renewals*, `contract.read`; decisions need `contract.write`; `src/services/renewals.ts`): active contracts queued by decision deadline (the notice deadline less the *renewal decision lead* setting), each set against the supplier commitments behind its lines from the service register (Pax8 commitment end, 20i domain expiry) with mismatches named and the supplier cost beyond the renewal date estimated; planned dated changes shown; the customer's decision (renew, amend, not renewing) recorded per renewal date and audited; *Prepare amendment* opens the contract with changes dated from the renewal date.
- Billing automation (Settings → *Billing automation*, `settings.write`; `src/services/billing-automation.ts`; worker `billing.automation` daily 07:00, acting once a month on or after the run day): level 0 detect only (default), 1 prepare drafts for ready contracts, 2 also create unchanged drafts in Xero through the normal approval; every run audited as `billing.automation.run` naming the policy; manual run from the page.
- Price review (Contracts → *Price review*, preview `contract.read`, apply `contract.write`; `src/services/price-reviews.ts`): a percentage, new price or supplier-cost pass-through across a product's or description's active lines, previewed with margins, monthly change, first invoice period and agreement constraints (prices fixed until renewal, agreement ending, not renewing, notice deadline near), applied as dated reasoned unit-price changes; audited as `pricing.review.apply`.
- Billing run (Finance → *Billing run*, `invoice.prepare`; planning in `src/services/billing-coverage.ts`): one draft per active contract carrying every line period that is due and not yet invoiced, billed in advance and anchored to the contract start date or billing day (a 31st clamps to month ends). Each recurring line is invoiced on its **schedule**: *with the contract* (price normalised to the contract's period, the default) or on its *own cycle* (an annual domain once a year). Coverage is per line period (a period or pro-rata line in a non-cancelled draft; older drafts cover their own period), so a drafted period is never proposed again and the run is safe to repeat. With a contract **Bill from (CRM)** date, earlier uncovered periods are proposed too and flagged *missed*; without one only the current period is, so a contract imported mid-life is never back-billed. Per-line **reduction policy**: decreases apply from the next period (default), are credited for the unused days, or wait until the renewal date. The page is an exception-focused workspace (`src/services/billing-workspace.ts`): a summary line (ready / needs review / blocked counts, expected total, potential missed revenue from unmapped services, renewals and notice deadlines this week) and, per contract, the previous comparable draft, the difference and plain-language reasons derived from the calculated lines, plus attention items (open discrepancies, unmapped services, stale Pax8 or NinjaOne data, missed periods, first invoice) and blockers (no Xero contact link). Ready rows are ticked by default; the chosen rows become ordinary drafts (`prepareInvoiceDraft`) for the usual review and approval, or one consolidated draft per customer when several agreements are due and *One draft per customer* is on (lines prefixed with the agreement name, `contract_ids` on the draft, coverage per contract line). Audited as `billing.run`. Every draft shows a plain-language customer explanation and a printable customer schedule (`src/services/customer-schedule.ts`); a contract's PO reference is carried onto its drafts and the first Xero line.
- Invoices: prepared from a contract period (with a calculated preview in the dialog) or a won opportunity → reviewed and edited → approved by `finance`/`admin` → created in Xero as **DRAFT** with `Reference = CRM-<id>`, `Idempotency-Key`, and an outbound-ledger row; approval claims the draft atomically (a second approval is told it is in progress, or gets the reused result; an approval stuck for ten minutes may be retried) and retries reconcile by reference. A draft whose contract changed after preparation is marked stale and can be re-prepared for the same periods; an invoice changed, voided or deleted in Xero after creation is flagged against the approved version. Pending drafts are reviewed on the Finance page against the previous comparable draft of their contract (`src/services/draft-review.ts`): unchanged ones (same lines, Xero linked, not stale, plain draft) can be approved together, each re-checked and approved through the single-draft path; exceptions list their flags and keep the one-by-one review. Approving, sending and payments stay in Xero. Invoice `Url` links back to the CRM draft.
- Deleted/archived: archived Xero contacts keep their link (`external_status = archived`) and raise a review item; nothing local is deleted.
- Demo: with `DEMO_MODE=true` and no tokens, an in-memory organisation with customers, invoices and payments is used and labelled *Demo (not connected)*.

## NinjaOne (Phase 5, built)

**Read-only by default.** The live client (`src/connectors/ninjaone/live.ts`) requests only the `monitoring` scope and has one write method, `createOrganization`, which refuses to run unless the credential was saved with the Management scope. It is used solely by the optional auto-create setting below.

### Setup (all in the web UI)

1. NinjaOne → Administration → Apps → API → *Client app IDs* → Add. Application platform **API Services (machine-to-machine)**, scope **Monitoring** (add **Management** only if the CRM should create organisations), any redirect URI (unused).
2. CRM → Integrations → NinjaOne → choose the region (EU = `eu.ninjarmm.com`), paste the client id and secret, tick *Allow the CRM to create organisations* if wanted → *Verify and connect*. The CRM requests a token with `grant_type=client_credentials&scope=monitoring` (or `monitoring management`) and only stores the credentials (encrypted) if that succeeds. The scope set is fixed per credential: to change it, reconnect.
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
- Each contract line with *Compare with NinjaOne* is compared with the billable count at the linked organisation, or at the linked location when the line names a site (unlinked site → skipped); lines of one contract sharing a scope are compared together as one pool (contracted = their sum). Devices marked internal or free in the service register (company Devices tab → *Billable?*) are left out of the count. Differences become review items (open → accepted / dismissed / resolved) on the Devices page, the company's Devices tab and the contract. Accepting or dismissing is audited; contracts and invoices are never changed by the CRM.

### Importing existing data

- **Xero customers → companies** (Xero page, *Xero customers not yet in the CRM*): creates a customer company from the contact (address, VAT/company number, email, phone, billing contact) and links it; links an obvious existing company (company number, VAT, email domain or exact name) instead of duplicating.
- **Xero repeating invoices → draft contracts** (Xero page, *Repeating invoices in Xero*): one recurring contract line per template line, tax-exclusive, frequency from the schedule (monthly / every 3 months / every 12 months; weekly and other periods are listed but skipped); Xero's DRAFT template status (generated invoices saved as drafts for approval) is imported like AUTHORISED, only DELETED templates are excluded, catalogue products matched by item code = SKU (sets pricing model, cost and device-count comparison); an item code with no product creates one from the Xero item (`GET /Items`: name, sale price, purchase price as cost; pricing model and category guessed from the wording, per-device products flagged for NinjaOne comparison), start/end dates from the schedule. The contract is created as **draft** and linked to the template id so re-running never duplicates. A person reviews and activates it.
- **NinjaOne organisations → companies** (NinjaOne page): same duplicate rules as the Xero import; devices are attached on link.
- **Companies → NinjaOne organisations** (NinjaOne page → Counting rules → *Create a NinjaOne organisation automatically when a company becomes a customer*, off by default): when a company is created as, or changes to, *customer* (including an opportunity being won), an organisation with one "Main Office" location (billing address) is created, mirrored and linked (`source = created_by_crm`). An organisation whose name already looks like the company's raises a review item instead; a read-only credential logs a timeline note asking for a reconnect with Management. Idempotent through the outbound ledger (`ninjaone:organization:<companyId>`), reconciled by exact name after a timeout. Failures never block the CRM change.

### Not available via the API (hand-off)

Remote control, scripts, reboots, device deletion, approving pending devices → done in the NinjaOne console. Device rows and company tabs deep-link to `https://<instance>/#/deviceDashboard/{id}/overview` and `customerDashboard/{orgId}`.

## 20i Hosting (Phase 8, built)

**Read-only by design.** The live client (`src/connectors/twentyi/live.ts`) has no write methods: the CRM never provisions, suspends, renews, transfers or changes DNS at 20i.

Verified against the public 20i API guides (docs.20i.com/api: authentication, "retrieve a list of packages", "provision a hosting package") and the community endpoint references derived from the Apiary reference (`my.20i.com/reseller/apiDoc`, which needs a reseller login). Shapes not shown in public material are handled defensively and kept verbatim in `raw`.

| | 20i Reseller API |
|---|---|
| **Account** | Any 20i reseller account; the **General API key** is under My20i → Reseller → API |
| **Auth** | `Authorization: Bearer <base64(general API key)>` per the docs. The connect step tries the base64 form first and falls back to the raw key on 401/403, then remembers which worked |
| **Base URL** | `https://api.20i.com` |
| **Read** | `GET /reseller` (identity), `GET /package` (`id`, `name`, `names[]`, `packageTypeName`, `enabled`, `created`, `stackUsers[]`, `packageLabels[]`), `GET /package/{id}/web/usage` (disk figures, best effort), `GET /package/{id}/email/{domain}/mailbox` (`local`, `domain`, `forUser`; 404/400 = no email service), `GET /domain` (`id`, `name`, `expiryDate`, `deadDate`, `closeToAnniversary`, `hasPrivacy`, `registrantIsVerified`) |
| **Write** | **None** |
| **Events** | No webhooks → `twentyi.sync` hourly at :40 plus *Sync now* |
| **Rate limits** | Not published → 150 ms spacing, back off on 429/5xx |
| **Deep links** | Package and domain management pages in My20i |
| **Hand-off** | Provisioning, suspending, renewing domains and certificates, DNS, mailbox passwords → My20i / StackCP |

### Setup (all in the web UI)

1. My20i → Reseller → API → copy the General API key.
2. CRM → Integrations → 20i Hosting → paste the key → *Verify and connect*. The key is stored encrypted only if `GET /reseller` and `GET /package` succeed.
3. Run *Sync now*. Packages, domains and mailboxes appear in the mapping table; exact domain matches are linked to companies automatically.

### What is mirrored

One table, `hosting_items`, with a `kind` of `package`, `domain`, `mailbox` (and `ssl`, reserved): 20i id, name, registrable domain used for matching, parent package, type, enabled flag, expiry date, disk usage, details (extra names, StackCP users, labels), `company_id`, how it was matched (`manual` / `auto` / `inherited`), the contract line that bills it, `external_status` (`deleted` when it disappears from 20i; rows and links are kept) and `fetched_at`. Domains are attached to the package whose names include them.

### Matching and billing

- **Auto-link** (configurable): a package or domain is linked when its registrable domain (`example.co.uk`, two-part UK suffixes handled) matches exactly **one** company's website domain or contact email domain. Two companies sharing a domain → suggestions only. Name similarity is never applied automatically.
- **Mailboxes inherit** the company of their package. **Unlinking is remembered** (`match_source = manual`, no company) so the next sync does not undo it.
- **Billed by**: on the company's **Hosting** tab each package and domain can be tied to a contract line of one of the company's draft or active contracts (`contract_line_id`; the line must belong to that company). Items linked to a company but billed by nothing show *not billed* on the mapping page and count in the *linked but not billed* figure, unless the service register records them as bundled, covered by a commitment, free or internal.
- **Invoices**: the Hosting tab lists mirrored Xero sales invoices for the company whose reference or line descriptions mention a package or domain name, with status and amount due, so a renewal can be checked against what was actually invoiced.
- **Reminders**: daily (`crm.reminders`), one task per domain or certificate expiring within the window (default 30 days; Integrations → 20i Hosting), priority high, urgent once expired, owned by the company's account owner; unlinked items produce a task that says so. Source key `hosting-expiry:<item>:<date>` keeps it idempotent.

### Not available via the API (hand-off)

Renewing, provisioning, suspending, DNS and mailbox administration happen in My20i / StackCP. Pricing and 20i's own invoices to the reseller are not read.

## Pax8 (Phase 12, built)

**Read-only by default.** The live client (`src/connectors/pax8/live.ts`) has three write methods: `createCompany` and `createContact`, used by the optional auto-create setting below, and `updateSubscription` (quantity only), used by the optional quantity-change setting. The CRM never orders or cancels a subscription at Pax8.

Verified against the public Pax8 Partner API reference (devx.pax8.com). Shapes not shown in public material are handled defensively and kept verbatim in `raw`.

| | Pax8 Partner API |
|---|---|
| **Account** | Any Pax8 partner; an API client (id + secret) is created under Settings → Integrations → Pax8 API in the partner portal |
| **Auth** | OAuth 2.0 `client_credentials` at `https://login.pax8.com/oauth/token`, JSON body with `client_id`, `client_secret`, `audience: api://p8p.client`. Bearer token on requests; cached encrypted with the credentials, refreshed on 401 |
| **Base URL** | `https://api.pax8.com/v1` |
| **Read** | `GET /companies` (`id`, `name`, `website`, `phone`, `address`, `externalId`, `status`), `GET /products` (`id`, `name`, `vendorName`, `sku`, `vendorSku`), `GET /subscriptions` (`id`, `companyId`, `productId`, `quantity`, `status`, `price`, `billingTerm`, `commitmentTerm`, `startDate`, `endDate`, `billingStart`), `GET /invoices` and `GET /invoices/{id}/items` (`companyId`, `productId`, `sku`, `description`, `quantity`, `unitPrice`, `total`, `startPeriod`, `endPeriod`, `chargeType`). All paged with `page` / `size` (200) |
| **Write** | `POST /companies` (name, full address, phone, website, `externalId` = CRM company id, bill-on-behalf / self-service / order-approval off, `contacts[]`) and `POST /companies/{id}/contacts` (`firstName`, `lastName`, `email`, `phone`, `types[{type: Admin|Billing|Technical, primary}]`) for the opt-in "create a company when a CRM company becomes a customer" setting (Pax8 leaves a company **Inactive**, hidden in the portal, until Admin, Billing and Technical each have a primary contact); `PUT /subscriptions/{id}` with `{ quantity }` for the opt-in "allow quantity changes" setting (404 when the subscription is gone, 422 for future-dated subscriptions or a count below the product minimum) |
| **Events** | No webhooks used → `pax8.sync` hourly at :50 plus *Sync now* |
| **Rate limits** | Not published → 200 ms spacing, back off on 429/5xx |
| **Deep links** | Company and subscription pages in the Pax8 portal |
| **Hand-off** | Ordering, cancellations, invoice payment → Pax8 portal (quantity changes too unless the setting is on) |

### Setup (all in the web UI)

1. Pax8 partner portal → Settings → Integrations → Pax8 API → create an API client, copy its id and secret.
2. CRM → Integrations → Pax8 → paste both → *Verify and connect*. They are stored encrypted only if `GET /companies` succeeds.
3. Run *Sync now*. Companies appear in the mapping table; exact domain or exact name matches are linked automatically, the licence check runs at the end of the sync.

### What is mirrored

`pax8_companies` (name, website and its registrable domain, phone, city, status, `company_id`, `manual` / `auto` match source, `external_status`), `pax8_products` (name, vendor, SKU, vendor SKU), `pax8_subscriptions` (product, quantity, status, partner price per term, billing term, commitment term and end, dates, the contract line a person chose, `company_id` derived from the company link), `pax8_invoices` (the last N partner invoices with status, dates, total, balance, the sum of their mirrored lines and the matched Xero bill) and `pax8_invoice_items` (their charge lines, per customer). Rows disappearing from Pax8 are marked `deleted`, never removed.

### Matching, licence check and costs

- **Auto-link** (configurable): a Pax8 company is linked when its website domain matches exactly **one** company's website or contact email domain, or its normalised name equals exactly one company's, and that company is not already linked to another Pax8 company. Similar names are suggestions only. **Unlinking is remembered.**
- **Auto-create** (Pax8 page → settings → *Create a Pax8 company automatically when a company becomes a customer*, off by default): when a company is created as, or changes to, *customer* (including an opportunity being won), or a contact of such a company is saved, a Pax8 company is created from the CRM name, billing address (`region` or city as state/province), phone and website, with the CRM id as Pax8's `externalId` and the CRM contacts as its contacts, then mirrored and linked (`match_source = manual`). Pax8 requires all of those fields plus at least one contact with an e-mail address (phone from the contact, its mobile, or the company): when anything is missing the company timeline says which, the hook runs again when a contact is saved, and *Create in Pax8* on the company's Subscriptions tab runs it by hand. Contact roles map to Pax8 types (billing → Billing, technical → Technical, decision maker / primary → Admin); a type nobody holds goes to the primary (or first) contact so every type has a primary and the company is **Active** immediately. A company already linked but still Inactive at Pax8 gets its contacts pushed by the same hook, or by *Push contacts to Pax8* on the Subscriptions tab (`pax8:contact:<pax8Id>:<email>`, skipping e-mails Pax8 already holds). A Pax8 company with the same registrable domain, the same normalised name or a shared name stem raises a review item instead. Idempotent through the outbound ledger (`pax8:company:<companyId>`), reconciled by external id or exact name after a timeout. Failures never block the CRM change.
- **Which line bills a subscription**: the line chosen on the company's **Subscriptions** tab wins; otherwise the catalogue product's SKU must equal the Pax8 SKU or vendor SKU; otherwise the product name (or the line description) must equal the Pax8 product name. Subscriptions with no line are flagged *not billed* unless the service register (company **Services** tab, Finance → Service coverage) says they are bundled into another line (then their licences count toward it), covered by a commitment, intentionally free or internal.
- **Licence check**: for every matched line of an active contract, contracted quantity vs the sum of licences on `Active`, `Activated` and `PendingCancel` subscriptions. Differences become `billing_discrepancies` rows with `source = pax8`, reviewed like device discrepancies (accept re-opens if the gap grows or once an exception's review date has passed; resolved automatically once counts match). Each open item offers concrete actions with their money consequence (`src/services/discrepancy-actions.ts`): amend the line from a date, reduce at renewal, include chosen subscriptions in a bundle line, accept as an exception with an owner and review date, or dismiss. Billing is never changed automatically.
- **Quantity changes** (Pax8 page → settings → *Allow licence quantity changes at Pax8*, off by default): when on, people with `contract.write` see *Change* next to the quantity of each Active subscription on the company's Subscriptions tab. The dialog shows the licences added or removed and the monthly partner-cost impact, requires a reason, and sends `PUT /subscriptions/{id}` with the new count. The mirror is updated from Pax8's reply, an audit entry `pax8.subscription.quantity` records from / to / reason, the company timeline gets a note, and the licence check runs so the contract comparison shows the new gap until the contract line is updated. Refused for subscriptions that are not Active, not linked to a CRM company, gone from Pax8, or for a count below 1 (cancelling stays in the Pax8 portal). Recorded in the outbound ledger (`pax8:sub-qty:<subscriptionId>:<quantity>:<mirror updated at>`) so a double submit is served from the ledger. The contract line is never changed by this action.
- **Pax8 invoices vs Xero bills** (Pax8 page → *Pax8 invoices vs Xero bills*): an admin picks the Xero supplier contact that is Pax8. Every sync then mirrors the last N Pax8 partner invoices at invoice level (`pax8_invoices`: status, date, total, balance, the sum of the mirrored charge lines) and every purchase bill Xero holds for that contact (into `xero_invoices` with `type = ACCPAY`; sales lists filter on ACCREC so bills never appear among customer invoices), and matches them: first a bill whose reference or number carries the Pax8 invoice id (or Pax8's `externalId`) as a whole token (*by reference*), then a unique bill with the identical total dated within ten days (*by amount and date*, weaker and shown in amber) (`src/lib/pax8-reconcile.ts`). The card shows each Pax8 invoice with its bill, the difference and a state (*total matched*, *amount differs*, *no bill in Xero*), plus any supplier bill in the imported window that no Pax8 invoice explains (*no Pax8 invoice*), with deep links into Xero. People with `invoice.approve` can match or unmatch by hand (`pax8.invoice.match` audit entry); a hand decision, including "no bill", is never overridden by the matcher. Changing the supplier drops automatic matches and re-runs. Nothing is written to Xero or Pax8.
- **Charge-level allocation**: each Pax8 charge line is tied to the customer (Pax8 company link) and the subscription (Pax8 product) with a finding: *no customer*, *no matching subscription*, *price differs from subscription*, *quantity differs* (informational). The reconciliation table shows lines, unallocated money and price findings per invoice; `/integrations/pax8/invoices/<id>` lists the charges by customer with the matched bill. A bill with several lines is compared line by line by amount; a one-line bill is reported as total-matched only.
- **Imported history**: the card states which Pax8 invoices the mirror holds and when they were fetched; supplier bills older than that are *outside imported history*, not a finding. *Import invoices from* a date (`integration.manage`, `pax8.invoices.import`) brings older invoices and charge lines in through the same upsert as the sync (no duplicates, hand matches kept); the routine sync keeps only the last N fresh but never removes imported ones.
- **Costs**: the Pax8 price is the partner cost per unit per term. The tab shows it per month, the margin per unit against the line's price, and flags a line whose recorded `unit_cost` differs by more than a penny a month. *Use as cost* (contract.write) copies it onto the line converted to the line's billing period and writes an audit entry; the sell price is never touched. *What Pax8 charged for this customer* totals the mirrored invoice lines per invoice.

### Not available via the API (hand-off)

Ordering, cancellations and paying Pax8 invoices happen in the Pax8 portal (quantity changes too while the setting is off).

