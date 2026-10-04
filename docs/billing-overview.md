# Billing in the Snelson Server CRM: how it looks and how it works

A self-contained briefing on everything to do with money in the CRM: contracts, the billing run, pro-rating, draft invoices, Xero, and the way Pax8, NinjaOne, 20i and Better Proposals feed into billing. Written so that someone (or an AI assistant) who has never seen the system can reason about it.

## 1. The system in one paragraph

The CRM is an internal web app for a UK managed service provider (MSP). It is a Next.js 15 application on PostgreSQL, deployed with Docker on a VPS, with a background worker for scheduled jobs. **Xero is the accounting system of record**: the CRM never sends invoices or takes payments itself. The CRM's job on the billing side is to hold the **contract** (what each customer has agreed to pay for), compare it with what the customer actually consumes according to the tools the MSP runs (NinjaOne for devices, Pax8 for Microsoft 365 and other licences, 20i for hosting), produce **draft invoices** from the contract each period, and push approved drafts into Xero as **DRAFT** invoices where finance approve and send them. Everything the CRM writes to an outside system goes through an idempotent outbound ledger and the audit log.

## 2. Roles that matter for billing

| Role | Billing-relevant permissions |
|---|---|
| admin | everything, including integration settings (`integration.manage`) |
| finance | `contract.write`, `invoice.prepare`, `invoice.approve`, `finance.read` |
| account_manager | `contract.write`, `invoice.prepare`, `discrepancy.review` (no approval, no finance totals) |
| sales | opportunities and proposals; cannot see Finance |
| technician, read_only | no billing rights |

Approving an invoice (which creates it in Xero) needs `invoice.approve` (finance or admin). Preparing drafts and running the billing run needs `invoice.prepare`.

## 3. The data model for billing

### 3.1 Catalogue (`products`)

Each product has a name, SKU, category, **pricing model** (`per_user`, `per_device`, `fixed`, `one_off`), **revenue type** (`recurring`, `one_off_project`, `hardware`), default **billing frequency** (`monthly`, `quarterly`, `annual`, `one_off`), a sell price and an optional unit cost. Per-device products can be flagged "counts as managed device" so NinjaOne device counts are compared against them. The SKU is also what Pax8 subscriptions are matched on.

### 3.2 Opportunities and proposals

Sales build an opportunity with line items drawn from the catalogue or typed by hand. Each line carries revenue type, pricing model, billing frequency, quantity, unit price and optional cost. Winning the opportunity (manually, or automatically when a Better Proposals proposal is signed) promotes the company to **customer** and drafts a **contract** from the opportunity's lines. One-off and hardware lines on a won opportunity can be invoiced directly (see 5.2).

### 3.3 Contracts (`contracts`, `contract_lines`)

A contract is the billing agreement for one company:

- **Header**: name, status (`draft`, `active`, `expired`, `cancelled`), start date, optional end date, renewal date, notice period, auto-renew flag, **billing frequency** (`monthly`, `quarterly`, `annual`), optional **billing day** (1 to 28; empty means periods are anchored on the start date), optional **Bill from (CRM)** date (billing commencement: uninvoiced periods from that date are proposed as missed; empty means only the current period is ever proposed), review date and interval, owner, linked opportunity, external proposal id.
- **Lines**: description, product (optional), revenue type, pricing model, **billing frequency of the line** (its price basis: per month, quarter or year), **invoice schedule** (*with the contract*: the price is spread over the contract's invoices, so an annual price on a monthly contract bills a twelfth each month; *own cycle*: invoiced once per its own period, anchored like the contract, e.g. a domain once a year), **reduction policy** (what a mid-period decrease does: lower quantity from the next period, credit the unused days, or old quantity until the contract's renewal date), **contracted quantity**, unit price, optional unit cost, optional site restriction (for per-device lines at one location), "compare with NinjaOne" flag. Lines keep their ids across edits, so history attached to a line survives.
- **Change history** (`contract_line_changes`): every quantity or unit-price change on a line of an active contract, every recurring line added or removed, with the value before and after, the day it takes effect (the form asks "Changes take effect from", default today), who recorded it, a reason, and the draft invoice that first accounted for it. This history is what drives pro-rating (see 4.3); it is never cleared, and cancelling a draft hands its changes back to the next one. The contract page lists it in a **Change history** card and shows pending changes under each quantity.

The contract page shows a **Contracted services** table (service, type, pricing, site, contracted qty, unit price, per period), the **device count check** against NinjaOne, terms and tasks. The line editor on the contract form is one row per line (product search, qty, unit price, total) with a details toggle for the less-used fields.

### 3.4 Revenue headlines

Two different numbers are shown and they are deliberately not the same:

- **Billed monthly / quarterly / annually**: what the invoice for each frequency actually carries. Monthly lines only, listed per month; quarterly lines listed per quarter; annual lines per year. This is what the contract page, company page, Contracts list and dashboard lead with, because it answers "what will the next invoice be?".
- **MRR (normalised)**: every recurring line normalised to a month (annual ÷ 12, quarterly ÷ 3). Shown alongside only when it differs, and used on the Reports page for recurring revenue, margin, concentration and renewals. One-off and hardware lines are excluded and reported separately. ARR is MRR × 12.

### 3.5 Draft invoices (`invoice_drafts`)

A CRM-side invoice draft: company, contract or opportunity, status (`draft`, `approved`, `created`, `failed`, `cancelled`), a unique reference `CRM-XXXXXXXX`, description, currency, invoice date, due date, **period start and end**, the lines as JSON (description, quantity, unit amount, account code, tax type, the contract line id it came from), net subtotal, notes, who prepared and approved it, and the Xero invoice id and number once created.

### 3.6 Mirrors of external data

The CRM keeps read-only copies of what the integrations report, each stamped with when it was fetched so the UI can say "cached", "stale" or "live":

- `xero_contacts`, `xero_invoices` (sales invoices, plus the purchase bills of the Xero contact chosen as the Pax8 supplier, kept apart by `type`), `xero_payments`
- `ninja_organizations`, `ninja_locations`, `ninja_devices`
- `pax8_companies`, `pax8_products`, `pax8_subscriptions`, `pax8_invoice_items`
- `hosting_items` (20i packages, domains, mailboxes)
- `bp_proposals`

Rows that disappear upstream are marked deleted or archived, never removed.

### 3.7 Service register (`service_coverage`)

Every service the integrations report for a customer (Pax8 subscriptions, 20i packages and domains, NinjaOne managed devices) has a commercial state, shown on the company's **Services** tab and across customers on Finance → **Service coverage**:

| State | Meaning | Effect |
|---|---|---|
| Charged on a line | its own contract line bills it (the billing line chosen on the Subscriptions or Hosting tab, or a Pax8 SKU / name match) | counted against that line |
| Included in a bundle | part of another line (e.g. Microsoft 365 seats inside a per-user managed package) | counted toward the bundle line in the licence check |
| Covered by commitment | paid for by a minimum-commitment line | counted against nothing |
| Intentionally free | not charged, with a reason and a review date | counted against nothing; flagged when the review date passes |
| Internal / non-billable | the MSP's own, a test tenant, an engineer's laptop | left out of counts and checks |
| Needs investigation | flagged with a note | shown first until decided |
| Unmapped | nobody has said | the only state that may mean missed revenue |

Decisions are audited and posted on the company timeline. Nothing in the register changes a contract or an invoice.

### 3.8 Review queue (`billing_discrepancies`)

Every automatic comparison between contract and reality lands here rather than changing anything: company, contract, contract line, source (`ninjaone` or `pax8`), contracted quantity, observed quantity, difference, estimated unbilled or over-billed amount per period, status (`open`, `accepted`, `dismissed`, `resolved`), who reviewed and why. Accepting or dismissing is audited and noted on the company timeline. **Nothing in this queue ever edits a contract or an invoice**; a person does that.

## 4. How billing periods and amounts are calculated

All of this lives in one pure module (`src/lib/billing.ts`) shared by the billing run and the manual "Prepare invoice" button, so both produce identical lines.

### 4.1 Periods

- The contract's billing frequency gives the period length in months (1, 3 or 12).
- **Without a billing day**, periods start on the contract start date and step by that many months (a 31st clamps to month ends).
- **With a billing day** (say the 1st), anchors are that day of the month. The first period runs from the start date to the day before the next anchor and is a short "stub"; later periods are whole.
- A period is described by its start, end, the number of days in the whole anchor-to-anchor period, and the number of days actually covered (shorter on a mid-period start or when the end date falls inside the period).
- Billing is **in advance**: the invoice for a period is prepared when that period is current.

### 4.2 Line amounts

For each recurring line (one-off lines are skipped here):

- Lines invoiced *with the contract* have their price normalised to the contract's period: an annual price on a monthly contract bills a twelfth each month; a monthly price on an annual contract bills twelve months. Lines on their *own cycle* use their own period (an annual domain bills its full price once a year).
- A **full period** produces `quantity × unit per period`, described as "Service (2026-10-01 to 2026-10-31)".
- A **partial period** (stub start or an end date inside the period) produces one line with quantity 1 and amount `quantity × unit per period × days covered ÷ days in full period`, described as "Service (dates): 14 × 9.40, 17 of 31 days (pro rata)".

### 4.3 Quantity and price changes mid-period (pro-rating)

The engine reconstructs the quantity on any day from the line's dated history:

- A period is charged at the quantity in force on its first day (whole or pro-rated as above).
- Each **increase** inside the period is added for its own remaining days: `increase × unit per period × days remaining ÷ days in full period`, one line per change day ("Service: 2 added from 2026-10-14, 18 of 31 days (pro rata)"). Several changes in one period each count for their own days. A change recorded with a reason keeps it.
- **Decreases** follow the line's reduction policy: *from the next period* (default) means no credit and the lower quantity from the next period; *credit the unused days* adds a negative line for the remaining days (and a credit catch-up when the drop fell in the previous, already invoiced, period); *until renewal* keeps billing the old quantity until the contract's renewal date, after which the real quantity applies.
- **Unit price changes** apply from the first period that starts on or after their effective day and are never pro-rated.
- **Catch-up**: if a change fell inside the previous, already invoiced, period and that invoice did not reflect it, the next invoice carries one line for the difference between what that period should have cost and what its draft actually billed for the line. A draft prepared after the change therefore never double-bills.
- Every engine-produced line carries its calculation inputs, shown on the draft page under **How these amounts were calculated**; hand-edited lines are flagged there.

Example: a 14-seat Microsoft 365 line at £9.40 per month, billed monthly on the 1st. The customer adds two users on 8 October, three more on 17 October and drops one on 25 October, all entered as they happen; the October invoice was prepared on 1 October at 14 seats. The November invoice carries one adjustment line for October (2 × 9.40 × 24/31 + 3 × 9.40 × 15/31 = £28.19, the drop is not credited) plus the November line at 18 × £9.40.

## 5. Producing invoices

### 5.1 The billing run (Finance → Billing run)

The intended monthly routine:

1. Open Finance → **Billing run**. Pick a run date (default today). The page lists **one row per active contract** with everything that is due and not yet invoiced: for each recurring line, its current period under its schedule (the contract's period, or the line's own cycle), plus, when the contract has a *Bill from* date, earlier periods that no draft covers, flagged **missed**. Each row shows company, contract, period, net amount, whether the company is linked to a Xero contact, and a status (ready, or why not).
2. **Coverage is per line and period**: a period of a line counts as invoiced when any non-cancelled draft carries it. A line period that is already drafted is never proposed again, so re-running the page is safe. Without a *Bill from* date nothing earlier than the current period is ever proposed, so a contract imported mid-life is never back-billed by accident.
3. Tick the rows wanted and click **Prepare drafts**. Each becomes an ordinary CRM draft carrying all of its items (its description says when missed periods are included). The run is audited as `billing.run`.
4. Review each draft (Finance → draft page): lines table (description, qty, unit, account, tax, line total), the **How these amounts were calculated** panel, details (dates, description, notes), and an **Approve and create in Xero** button for finance/admin. Lines can be edited before approval.
5. Approval creates the invoice in Xero as **DRAFT** (never authorised), with `Reference = CRM-XXXXXXXX`, an `Idempotency-Key` header, the configured account codes, tax type, due date from payment terms and branding theme. The Xero invoice's URL field links back to the CRM draft. A failed attempt is retried by looking the invoice up by reference first, so a retry can never create two invoices.
6. Finance then approve and send from Xero as usual. Payments and status changes flow back through Xero webhooks and the hourly sync, and appear on the Finance page and the company's Invoices tab.

### 5.2 Manual preparation

- **Prepare invoice** on an active contract: the current anchored period by default, or a hand-typed period. The dialog shows the calculated lines and net for the chosen dates before anything is created, and warns when a period inside them is already drafted. Lines invoiced with the contract are built for that period (a span inside one anchored period is pro-rated against it; a span crossing anchors is billed as typed); lines on their own cycle are included only when their own period starts inside it. Manual preparation does not block a deliberate re-bill.
- **Prepare invoice** on a won opportunity: the one-off project and hardware lines only (hardware goes to the hardware account code). Recurring lines are left to the contract.

### 5.3 Draft lifecycle

- A draft awaiting approval is marked **stale** when its contract changed after it was prepared (terms, a line, or a dated change). The draft page lists the changes since and offers **Re-prepare from the contract**: the old draft is cancelled (its coverage and changes are handed back) and a fresh one is prepared for the same stretch of periods.
- **Cancelling** a draft never deletes it; its periods become due again and its changes await the next draft.
- **Approval** claims the draft atomically, so two approvals at once cannot both create an invoice; the second sees "being approved already" or the reused result. An approval that never settled is retried after ten minutes, with the ledger looking the invoice up by reference first.
- After creation, an invoice **changed in Xero** (net amount, currency, voided or deleted) is flagged on the draft page and in a Finance card against the approved version. Xero's invoice remains what the customer receives.

### 5.4 What the Finance page shows

Headline stats: outstanding (authorised) total, overdue total and count, paid in the last 30 days, drafts in Xero awaiting approval there, CRM drafts awaiting approval here. Then a table of CRM drafts awaiting approval, and the mirrored Xero sales invoice list with filters (search, status, overdue only), sortable columns, defaulting to newest invoice date first, and a warning on invoices whose Xero contact is not linked to a CRM company.

The company page's **Invoices** tab (hidden from roles without `finance.read`) shows the Xero balances for the contact, 12-month invoiced and paid, invoice history, and pending CRM drafts.

## 6. Xero: the accounting system

**Set-up**: a Xero app (client id and secret in the server environment), a webhook for Contacts and Invoices, then Connect in the CRM, choose the organisation, choose invoice defaults (sales account code, hardware account code, tax rate, payment terms, branding theme, all read live from Xero), and map customers to Xero contacts (accept a suggestion, search, or create in Xero).

**Sync**: hourly incremental (`If-Modified-Since` with overlap) for contacts, ACCREC sales invoices and payments; nightly full reconciliation; webhook events applied within a minute; manual Sync now and Full reconciliation buttons.

**Field ownership**: Xero owns legal name, addresses, tax number, balances, invoice status and payments; the CRM never writes those. The CRM owns owner, tags, sites, contact roles, opportunities and contracts. Email and phone are pushed to Xero only by an explicit Push click, refused with a review item if Xero changed first.

**Auto-create** (optional): when a company becomes a customer, a Xero contact is created and linked unless Xero already has a likely match, in which case a review item asks you to link instead.

**Imports** for getting started: Xero customers → CRM companies; Xero **repeating invoices → draft contracts** (one recurring line per template line, frequency from the schedule, catalogue product matched by item code = SKU, or a product created from the Xero item), so existing recurring billing becomes contracts that a person reviews and activates.

**Purchase bills**: only the bills of the Xero contact chosen as the Pax8 supplier are mirrored (type ACCPAY, kept out of every sales list), for the Pax8 reconciliation described in section 7.

## 7. Pax8: licences and partner cost

Pax8 is the distributor the MSP buys Microsoft 365 and other cloud subscriptions through. The CRM connects with a Pax8 API client (id and secret), syncs hourly, and mirrors companies, products, every subscription (quantity, status, partner price per term, billing term, commitment end) and the charge lines of the last N partner invoices.

**Linking**: Pax8 companies are linked to CRM companies automatically on an exact website-domain or exact-name match (one candidate only); similar names are suggestions. Unlinking is remembered. A new customer can be **created at Pax8** from the CRM (optional auto-create when a company becomes a customer): full billing address, phone, website, CRM id as external id, and the CRM contacts mapped to Pax8's Admin, Billing and Technical roles so the company is Active immediately. Contacts can be pushed later for a company Pax8 still shows as Inactive.

**Which contract line bills a subscription**: the line a person chose on the company's **Subscriptions** tab wins; otherwise the catalogue product's SKU must equal the Pax8 SKU or vendor SKU; otherwise the product name or line description must equal the Pax8 product name. Subscriptions with no line are flagged **not billed** and counted on the Pax8 page.

**Licence check**: for every matched line of an active contract, contracted quantity vs the sum of licences on Active, Activated and PendingCancel subscriptions. Differences become review items with `source = pax8`, with an estimated unbilled or over-billed amount per period, reviewed like device discrepancies. Runs inside every sync, after a link change, after a quantity change, and on Re-check licences.

**Cost and margin**: the Pax8 price is the partner cost per unit per term. The Subscriptions tab shows it per month, the margin per unit against the line's sell price, and flags lines whose recorded unit cost differs by more than a penny a month. **Use as cost** copies the Pax8 price onto the contract line (converted to the line's billing period, audited); the sell price is never touched. This is why margin on the Contracts and Reports pages is real rather than a catalogue estimate.

**What Pax8 charged for this customer**: a per-customer table of the mirrored partner invoice lines (invoice date, invoice, lines, cost), so partner cost can be compared with what the customer was invoiced.

**Pax8 invoices vs Xero bills** (Pax8 page): an admin picks the Xero supplier contact that is Pax8. Each sync mirrors the recent Pax8 partner invoices and that supplier's Xero purchase bills and matches them, first by a bill reference or number carrying the Pax8 invoice id, then by a unique identical total within ten days. The card lists each Pax8 invoice with its bill, the difference and a state (matched, amount differs, no bill in Xero), plus any supplier bill that no Pax8 invoice explains. Finance can match or unmatch by hand and that decision sticks. Nothing is written to Xero or Pax8; entering and paying bills stays in Xero.

**Quantity changes from the CRM** (opt-in, admin setting "Allow licence quantity changes at Pax8"): when on, people with `contract.write` get a **Change** button next to each Active subscription's quantity. The dialog shows licences added or removed and the monthly partner-cost impact, requires a reason, and sends the new count to Pax8. The mirror, audit log (`pax8.subscription.quantity`, from/to/reason) and company timeline are updated and the licence check re-runs, so a gap against the contract shows until someone updates the contract line (which then pro-rates per section 4.3). Cancelling and ordering stay in the Pax8 portal; the CRM never does either.

**The intended loop for a Microsoft 365 seat change**: customer asks for two more users → change the quantity at Pax8 (from the CRM or the portal) → licence check flags "contracted 14, at Pax8 16" → account manager edits the contract line to 16 effective from the request date → next billing run pro-rates the increase → review item resolves itself once counts match.

## 8. NinjaOne: devices

NinjaOne is the RMM. The CRM reads organisations, locations and devices (name, class, OS, last contact, approval status, health) hourly and links organisations to companies and locations to sites by hand (or creates an organisation when a company becomes a customer, if that setting is on and the credential has the Management scope).

**Counting rules** (Settings and the NinjaOne page): a device is **active** if it contacted NinjaOne within the active window (default 30 days); **billable** if active, of a billable node class (default workstations, servers, VM guests) and, optionally, approved.

**Device count check**: every contract line marked "compare with NinjaOne" on an active contract is compared with the billable count at the linked organisation, or at the linked location when the line names a site. Lines of one contract that share a scope are compared together (contracted = their sum, one review item naming all of them). Devices marked internal or free in the service register are left out. Differences become review items with `source = ninjaone` on the Devices page, the company's Devices tab and the contract page, with the estimated unbilled or over-billed amount per period. Re-checked after every sync, link change and rule change; matched counts resolve the item; accepted items re-open only if the gap grows.

NinjaOne has no pricing, so it only informs quantities, never cost.

## 9. 20i: hosting, domains and mailboxes

20i is the reseller hosting platform. The CRM reads packages, domains (with expiry dates) and mailboxes hourly, matches them to companies by registrable domain (exactly one company's website or contact email domain), and lets a person tie each package or domain to the **contract line that bills it** on the company's Hosting tab. Items linked to a company but billed by nothing are flagged **not billed**. The Hosting tab also lists mirrored Xero invoices whose reference or lines mention the package or domain name, so a renewal can be checked against what was actually invoiced. Daily reminders create tasks for domains and certificates expiring within a window (default 30 days). 20i pricing and 20i's own invoices to the reseller are not read, and nothing is written to 20i.

## 10. Better Proposals: where billing starts

Proposals are built and signed in Better Proposals. The CRM creates the proposal from an opportunity (template, recipients, merge tags), mirrors its status, and on **signed** marks the opportunity won, promotes the company to customer, creates onboarding and drafts the contract from the opportunity lines, once per proposal. Companies are pushed to Better Proposals (name only; the API has no contact endpoint, contacts travel as proposal recipients). Nothing financial flows back from Better Proposals other than the signed status.

## 11. Guardrails that apply to all billing writes

- **Idempotency**: every outbound write (Xero invoice, Xero contact, Pax8 company, contact and quantity change, NinjaOne organisation, Better Proposals company and proposal) first records a row in `outbound_requests` keyed by a deterministic key; retries reuse it and an in-flight row is settled by looking the record up at the provider by reference before any second attempt.
- **Audit**: preparing, editing, approving and cancelling drafts, the billing run, cost copies, quantity changes, discrepancy reviews and every integration write are in the audit log with actor, entity and details.
- **Timeline**: customer-visible consequences (contract drafted, invoice approved, licence or device discrepancy reviewed, Pax8 quantity changed, company created at a provider) are posted on the company's activity timeline.
- **Nothing automatic changes money**: syncs and checks only produce review items; invoices are only ever created as Xero drafts; the contract is edited by a person.
- **Demo mode**: with no credentials and `DEMO_MODE=true`, every connector has an in-memory demo adapter with synthetic data, labelled "Demo (not connected)" everywhere, so the whole billing flow can be exercised without touching real systems.

## 12. Known gaps and open decisions

- Pax8 reconciliation is invoice-level only: it compares totals, not the individual charge lines of a bill, and only covers the last N Pax8 invoices the mirror holds.
- Xero's "invoiced vs contracted" comparison still uses normalised MRR rather than the billed-per-frequency figure.
- 20i hosting counts are not yet compared with contract quantities the way devices and licences are.
- Decreases in quantity are never credited mid-period (by design; they apply from the next period). Credit notes are not produced by the CRM.
- Weekly and other non-standard Xero repeating-invoice schedules are listed but not imported as contracts.
- Multi-currency: drafts carry the app's configured currency; there is no per-customer currency.
- Tax is a single configured Xero tax type per draft line (tax-exclusive amounts); there is no per-line VAT logic beyond that.

## 13. Where the code is

| Area | Files |
|---|---|
| Billing maths (periods, history, pro-rata, line building, explanations) | `src/lib/billing.ts` |
| Improvement plan against the brief | `docs/billing-improvement-plan.md` |
| Billing run | `src/services/billing-run.ts`, `src/app/(app)/finance/billing-run/` |
| Draft invoices and Xero | `src/services/xero.ts`, `src/connectors/xero/`, `src/app/(app)/finance/` |
| Contracts and revenue summaries | `src/services/contracts.ts`, `src/lib/money.ts`, `src/components/lines-editor.tsx` |
| Pax8 | `src/services/pax8.ts`, `src/connectors/pax8/`, `src/components/subscriptions-panel.tsx` |
| NinjaOne and the discrepancy engine | `src/services/ninjaone.ts`, `src/connectors/ninjaone/` |
| 20i | `src/services/twentyi.ts`, `src/connectors/twentyi/` |
| Better Proposals | `src/services/proposals.ts`, `src/connectors/betterproposals/` |
| Outbound ledger, links, conflicts | `src/services/integrations.ts` |
| Schema | `src/db/schema/sales.ts` (contracts), `xero.ts`, `pax8.ts`, `ninjaone.ts`, `hosting.ts` |
| Longer docs | `docs/integrations.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/phases.md` |
