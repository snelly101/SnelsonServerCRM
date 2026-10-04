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

The contract page shows a **Contracted services** table (service, type, pricing, site, contracted qty, unit price, per period), the **device count check** against NinjaOne, terms and tasks. **Archive** on the contract page sets `archived_at` (nothing is deleted): the contract leaves the contracts list, MRR, the service register and the billing run; a confirmation toast appears and you land on the contracts list, where **Show archived** lists archived contracts. An archived contract's page carries an **Archived** banner and a **Restore** button that clears `archived_at`. Both actions are audited (`contract.archive`, `contract.restore`) and logged on the company timeline. The line editor on the contract form is one row per line (product search, qty, unit price, total) with a details toggle for the less-used fields.

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

Every service the integrations report for a customer (Pax8 subscriptions, 20i packages and domains, NinjaOne managed devices) has a commercial state, shown on the company's **Services** tab and across customers on Billing → **Services**:

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

Every automatic comparison between contract and reality lands here rather than changing anything: company, contract, contract line, source (`ninjaone` or `pax8`), contracted quantity, observed quantity, difference, estimated unbilled or over-billed amount per period, status (`open`, `accepted`, `dismissed`, `resolved`), who reviewed and why. Each open item has a **Resolve** dialog with the concrete actions and the money consequence shown before anything happens (`src/lib/discrepancy-impact.ts`, worked out with the engine's period rules):

- **Amend the contract line** to the observed count from a chosen date: a dated quantity change with a reason, so the next invoice pro-rates the increase (or applies the decrease by the line's reduction policy) and the change history shows it. The item is resolved and linked to the change.
- **Reduce at renewal** (fewer observed than contracted, contract has a renewal date): the line takes the lower count but its reduction policy becomes *at renewal*, so the agreed count is billed until the renewal date.
- **Include in a bundle** (licence items): chosen subscriptions are marked as covered by another line of the contract, so they stop counting against this one; the licence check runs again at once.
- **Accept as an exception** with an **owner**, a **review date** and a reason: the item stays accepted until that date and then re-opens by itself (checked on every sync and re-check), with the expiry noted. Accepted items also re-open earlier if the gap grows.
- **Dismiss**: not a billing matter.

Every action is audited (`discrepancy.amend_line`, `.reduce_at_renewal`, `.include_in_bundle`, `.exception`, `.dismissed`) and noted on the company timeline. Nothing here edits an invoice; contract changes go through the same history as a manual edit.

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

### 5.0 The Billing area

Everything about money sits under one sidebar entry, **Billing**, with a fixed sub-navigation in the order the work flows:

| Section | What it is for |
|---|---|
| **Overview** | Where this month stands and a "what to do next" list that links straight into the steps below. |
| **Monthly run** | Three steps as tabs: **Prepare** (the exception-focused workspace, 5.1), **Approve** (the draft review with batch approval, 5.3), **Issued** (what was created in Xero, and anything changed in Xero after approval). |
| **Exceptions** | Findings (5.4), licence and device count discrepancies (3.8) and accepted exceptions, in one place with the Resolve dialog. |
| **Services** | The service register (3.7): what we provide against what we bill, per customer. |
| **Renewals & pricing** | The renewal queue (5.5) and the price review (5.6). |
| **Invoices** | The Xero sales mirror (outstanding, overdue, paid) and the Pax8 supplier bill reconciliation (7). |
| **Automation ↗** | The staged automation policy in Settings (5.8). |

Contracts keeps agreements and the catalogue; the Devices and Pax8 integration pages keep their contextual discrepancy lists and link into Exceptions.

Each company page has a **Billing** tab (`src/services/company-billing.ts`): the same picture narrowed to that customer. A "what to do next" list for the customer, the Xero balances, every active agreement with what the next run proposes and why (ready / needs review / blocked, previous invoice, reasons), drafts awaiting approval with batch approval, open and accepted count discrepancies with the Resolve dialog, renewals with the decision button, the service coverage counts, and the invoices created in Xero with links to their customer schedules. Old addresses (`/finance/…`, `/contracts/renewals`, `/contracts/price-reviews`) redirect.


### 5.1 The billing run (Billing → Monthly run → Prepare)

The intended monthly routine:

1. Open Billing → **Monthly run**, step 1 **Prepare**. Pick a run date (default today). The page opens with one summary line for the month: how many contracts are **ready**, how many **need review**, how many are **blocked**, the expected billing total, the potential missed revenue across services without commercial coverage, and renewals and notice deadlines falling in the next seven days. Below it is **one row per active contract** with everything that is due and not yet invoiced: for each recurring line, its current period under its schedule (the contract's period, or the line's own cycle), plus, when the contract has a *Bill from* date, earlier periods that no draft covers, flagged **missed**. Each row shows company, contract, period, the proposed net, the **previous comparable draft** (the one ending the day before, else the latest earlier one, linked), the difference against it, and a status:
   - **Ready**: Xero-linked, same amount as the previous invoice, nothing open against the customer. Ticked by default.
   - **Needs review**: something deserves a look before preparation. Items are listed in amber: a changed amount with plain-language **reasons** derived from the calculated lines (quantity or price changes per line, new or removed lines, pro-rated additions, credited reductions, catch-ups, missed periods, lines due on their own cycle), open licence or device discrepancies (with the unbilled amount per period), services without commercial coverage, stale Pax8 or NinjaOne data (not fetched for three hours), or a first invoice from the CRM. Tickable, not ticked by default.
   - **Blocked**: the company has no Xero contact link, so a draft could not be approved. Cannot be ticked; the row links to the fix.
   The *why* toggle on a row shows the reasons; reasons never guess, they are read from the calculated lines against the previous draft's lines.
2. **Coverage is per line and period**: a period of a line counts as invoiced when any non-cancelled draft carries it. A line period that is already drafted is never proposed again, so re-running the page is safe. Without a *Bill from* date nothing earlier than the current period is ever proposed, so a contract imported mid-life is never back-billed by accident.
3. Tick the rows wanted and click **Prepare drafts**. Each becomes an ordinary CRM draft carrying all of its items (its description says when missed periods are included). The run is audited as `billing.run`.
4. Review each draft (step 2 **Approve**, then the draft page): lines table (description, qty, unit, account, tax, line total), the **How these amounts were calculated** panel, details (dates, description, notes), and an **Approve and create in Xero** button for finance/admin. Lines can be edited before approval.
5. Approval creates the invoice in Xero as **DRAFT** (never authorised), with `Reference = CRM-XXXXXXXX`, an `Idempotency-Key` header, the configured account codes, tax type, due date from payment terms and branding theme. The Xero invoice's URL field links back to the CRM draft. A failed attempt is retried by looking the invoice up by reference first, so a retry can never create two invoices.
6. Finance then approve and send from Xero as usual. Payments and status changes flow back through Xero webhooks and the hourly sync, and appear on the Finance page and the company's Invoices tab.

### 5.2 Manual preparation

- **Prepare invoice** on an active contract: the current anchored period by default, or a hand-typed period. The dialog shows the calculated lines and net for the chosen dates before anything is created, and warns when a period inside them is already drafted. Lines invoiced with the contract are built for that period (a span inside one anchored period is pro-rated against it; a span crossing anchors is billed as typed); lines on their own cycle are included only when their own period starts inside it. Manual preparation does not block a deliberate re-bill.
- **Prepare invoice** on a won opportunity: the one-off project and hardware lines only (hardware goes to the hardware account code). Recurring lines are left to the contract.

### 5.3 Draft lifecycle

- A draft awaiting approval is marked **stale** when its contract changed after it was prepared (terms, a line, or a dated change). The draft page lists the changes since and offers **Re-prepare from the contract**: the old draft is cancelled (its coverage and changes are handed back) and a fresh one is prepared for the same stretch of periods.
- **Cancelling** a draft never deletes it; its periods become due again and its changes await the next draft.
- **Batch approval of unchanged drafts** (Billing → Monthly run → step 2 **Approve**): each pending draft is reviewed against the previous comparable draft for its contract (the one ending the day before its period, else the latest earlier one). A draft is **unchanged** when it came from a contract, the company is linked to a Xero contact, the contract has not changed since it was prepared, it is a plain draft (not failed, not mid-approval) and its lines match the previous draft line for line (same contract lines, quantities and unit prices; no pro-rata, increase, decrease or catch-up lines). Unchanged drafts are ticked by default and **Approve N in Xero** creates them one after another through the normal single-draft approval, re-checking each at the moment of approval; anything that stopped being unchanged meanwhile is skipped with the reason. Everything else is an **exception** with its flags (hand-prepared, no Xero link, failed, stale, first invoice from the CRM, amount differs with the *why* reasons) and keeps the one-by-one review. Audited as `invoice.approve.batch` plus the usual per-draft entries.
- **Approval** claims the draft atomically, so two approvals at once cannot both create an invoice; the second sees "being approved already" or the reused result. An approval that never settled is retried after ten minutes, with the ledger looking the invoice up by reference first.
- After creation, an invoice **changed in Xero** (net amount, currency, voided or deleted) is flagged on the draft page and in a Finance card against the approved version. Xero's invoice remains what the customer receives.

### 5.4 Findings (Billing → Exceptions)

One list of what needs a decision, read across the service register, the billing run, the drafts, Xero and the Pax8 reconciliation, each with its interpretation and a link to where it is resolved:

| Finding | Interpretation |
|---|---|
| Service without commercial coverage | potential missed revenue |
| Free arrangement past its review date | decide: stays free, charged, or ends |
| Covered service without an expected charge | its line is on a non-active contract or has quantity 0 |
| Expected charge not yet drafted | a line period is due and no draft carries it (missed periods in red) |
| Draft waiting more than a week | approve, re-prepare or cancel |
| Customer invoice differs from what was approved | changed, voided or deleted in Xero |
| Supplier charge differs from expectation | Pax8 invoice vs bill, charge vs subscription price, bill with no invoice |
| Supplier charge without a customer | Pax8 company not linked, or no subscription explains it |
| Customer invoice raised outside the CRM | informational |

### 5.5 What the Billing overview shows

Headline stats: outstanding (authorised) total, overdue total and count, paid in the last 30 days, drafts in Xero awaiting approval there, CRM drafts awaiting approval here. Then a table of CRM drafts awaiting approval, and the mirrored Xero sales invoice list with filters (search, status, overdue only), sortable columns, defaulting to newest invoice date first, and a warning on invoices whose Xero contact is not linked to a CRM company.

The company page's **Invoices** tab (hidden from roles without `finance.read`) shows the Xero balances for the contact, 12-month invoiced and paid, invoice history, and pending CRM drafts.

### 5.5 Renewals (Billing → Renewals & pricing)

Every active contract with a renewal date, queued by its **decision deadline**: the notice deadline (renewal date minus the notice period) less the *renewal decision lead* in Settings → General (default 30 days). Statuses are *decision overdue*, *decide now* (inside the lead), *upcoming* and *decided*.

Each row sets the customer's renewal against the **supplier commitments** behind the contract's lines, read from the service register through the lines they are charged on (Pax8 subscription commitment end dates, 20i domain expiries; devices carry no commitment). Two mismatches are named in plain words:

- *The agreement renews on 31 December but the supplier commitment runs to 30 September*: the months beyond the renewal date and, where the partner cost is known, the money that stays payable if the customer does not renew (**exposure**).
- *The supplier commitment renews before the agreement; the cost may change first*.

Planned quantities and prices (dated line changes after today) are listed, so the next invoice after renewal is already visible. Account managers **record the customer's decision** for that renewal date: renew as is, renew with amendments, or not renewing (with a reason). The decision is audited, posted on the company timeline and cleared automatically when the renewal date moves. **Prepare amendment** opens the contract edit form with *Changes take effect from* set to the renewal date, so the amendment lands as dated history and the *Prepare invoice* preview shows its effect before anything reaches Xero. The contract page carries the same card. The daily reminder job still raises a task at the notice deadline.

### 5.6 Price reviews (Billing → Renewals & pricing → Price review)

A proposed change to a sell price is never applied silently. The review takes a scope (a catalogue product, or contract lines whose description contains a phrase), a change (a percentage, a new unit price, or a new supplier unit cost passed through at the same margin), an effective date and a reason, and shows every affected active contract line before anything happens: customer, quantity, price now and after, cost now and after, margin now and after, the monthly revenue change, the day the change applies for that customer and the first invoice period that carries it (price changes apply from the next anchored period on or after the day and are never pro-rated), plus the **agreement constraints**: *prices fixed until renewal* on the contract (the change applies from the renewal date instead), the agreement ending before the change (not applicable), a customer who has said they are not renewing, and a notice deadline within 30 days. Totals give monthly revenue and blended margin before and after.

Applying (contract.write) records a dated unit-price change (and cost, for a pass-through) on every selected line with the reason, through the same history as a manual edit, so the contract page, the billing run's reasons and the draft explanation all say why the price moved. Optionally the catalogue list price is updated too. Audited as `pricing.review.apply`.

**Signed terms.** When a Better Proposals signature is processed, the opportunity's lines at that moment are captured on the proposal as the terms the agreement was activated from. If the opportunity was edited after the signature, the proposal is flagged *terms changed after signature*, a mapping conflict is raised and the contract page shows the warning next to the proposal, so a later edit never becomes the agreement silently.

### 5.7 What the customer sees (explanation, schedule, PO, consolidation)

- **Plain-language explanation.** Every draft page shows *What the customer sees*: one paragraph derived from the calculated lines, never guessed (`src/lib/customer-explanation.ts`): *Your charge for 1 to 30 November 2026 includes 16 × Microsoft 365 Business Standard, plus £10.92 for 2 × Microsoft 365 Business Standard added on 14 October 2026.* Credits for removed items, adjustments for an earlier period, pro-rated starts and hand-typed lines are worded the same way.
- **Customer schedule** (draft page → *Customer schedule*, printable): the explanation, the charges grouped by agreement with service dates, quantities and amounts, the **supporting schedule** of licences, devices and domains the service register ties to each charged line, and the agreement's renewal date and notice deadline. Printed or saved as PDF to accompany the Xero invoice; the invoice itself still comes from Xero.
- **Purchase order reference.** A contract's *Customer PO reference* is copied onto every draft prepared from it, shown on the draft and the schedule, and appended to the first line description sent to Xero (*"… (PO PO-2026-118)"*), so it appears on the invoice without touching the CRM reference used for reconciliation.
- **Consolidated customer invoices.** The billing run's *One draft per customer* option (on by default) prepares one draft when several agreements of the same customer are due: lines are prefixed with the agreement name, the draft records the agreements it covers (`contract_ids`), coverage counts for each of them (a line period is covered through its contract line whichever draft carries it), dated changes on every agreement are settled, staleness looks at all of them, re-preparing rebuilds the consolidated draft, cancelling releases every agreement, and the Finance review compares it with the previous consolidated draft of the same agreements. One settings currency and one Xero contact per customer are what make consolidation safe; drafts prepared by hand or from a single agreement are unchanged.

### 5.8 Staged automation (Settings → Billing automation)

Automation goes as far as the policy says and no further, in the brief's stages: detect, propose, prepare, then explicitly permitted routine approval.

| Level | What runs by itself | What stays with people |
|---|---|---|
| 0 Detect only (default) | Findings, the billing workspace, the draft review and the renewal queue are kept current | Everything else |
| 1 Prepare ready drafts | On the run day each month, drafts are prepared for contracts the workspace rates **ready** (Xero linked, same amount as last time, nothing open), consolidated per customer if the policy says so | Review and approval; every *needs review* and *blocked* contract |
| 2 Prepare, then approve unchanged | As 1, then drafts the review finds **unchanged** (same lines as the previous invoice, not stale, Xero linked, plain draft) are created in Xero as drafts through the normal approval path with its atomic claim and outbound ledger | Every exception; authorising and sending in Xero |

The scheduled job runs daily at 07:00 and acts once per month on or after the configured run day; administrators can run the policy by hand from the settings page at any time. Every run is audited as `billing.automation.run` naming the policy level, the trigger and what it prepared, approved or left for review, and the last run's summary is shown on the page. Financial calculations, commercial rules and posting decisions remain deterministic: automation only applies the same rules a person applies on the billing run and the draft review.

The customer portal (authorised contacts viewing services, requesting changes, approving quotes, raising queries against charges) remains future work, to be built on these foundations with customer permissions enforced independently of internal roles.

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

**Pax8 invoices vs Xero bills** (Billing → Invoices → Supplier bills; the Pax8 integration page keeps a summary): an admin picks the Xero supplier contact that is Pax8. Each sync mirrors the recent Pax8 partner invoices and that supplier's Xero purchase bills and matches them, first by a bill reference or number carrying the whole Pax8 invoice id (*by reference*), then by a unique identical total within ten days (*by amount and date*, weaker and shown as such). The card lists each Pax8 invoice with its bill, the difference and a state (total matched, amount differs, no bill in Xero), plus any supplier bill that no Pax8 invoice explains, and states the imported history (bills older than it are outside imported history, not a finding). Finance can match or unmatch by hand and that decision sticks. An admin can import older invoices from a date without duplicating anything.

**Charge-level allocation**: every Pax8 charge line is tied to the customer and the subscription it belongs to, with findings for lines that have no customer (Pax8 company not linked), no matching subscription, or a unit price that differs from the subscription. A Xero bill with line detail is compared line by line by amount; a one-line bill is only ever "total matched". Nothing is written to Xero or Pax8; entering and paying bills stays in Xero.

**Quantity changes from the CRM** (opt-in, admin setting "Allow licence quantity changes at Pax8"): when on, people with `contract.write` get a **Change** button next to each Active subscription's quantity. The dialog shows licences added or removed and the monthly partner-cost impact, requires a reason, and sends the new count to Pax8. The mirror, audit log (`pax8.subscription.quantity`, from/to/reason) and company timeline are updated and the licence check re-runs, so a gap against the contract shows until someone updates the contract line (which then pro-rates per section 4.3). Cancelling and ordering stay in the Pax8 portal; the CRM never does either.

**The intended loop for a Microsoft 365 seat change**: customer asks for two more users → change the quantity at Pax8 (from the CRM or the portal) → licence check flags "contracted 14, at Pax8 16" → account manager edits the contract line to 16 effective from the request date → next billing run pro-rates the increase → review item resolves itself once counts match.

## 8. NinjaOne: devices

NinjaOne is the RMM. The CRM reads organisations, locations and devices (name, class, OS, last contact, approval status, health) hourly and links organisations to companies and locations to sites by hand (or creates an organisation when a company becomes a customer, if that setting is on and the credential has the Management scope).

**Counting rules** (Settings and the NinjaOne page): a device is **active** if it contacted NinjaOne within the active window (default 30 days); **billable** if active, of a billable node class (default workstations, servers, VM guests) and, optionally, approved.

**Device count check**: every contract line marked "compare with NinjaOne" on an active contract is compared with the billable count at the linked organisation, or at the linked location when the line names a site. Lines of one contract that share a scope are compared together (contracted = their sum, one review item naming all of them). Devices marked internal or free in the service register are left out. Differences become review items with `source = ninjaone` on the Devices page, the company's Devices tab and the contract page, with the estimated unbilled or over-billed amount per period. Re-checked after every sync, link change and rule change; matched counts resolve the item; accepted items re-open if the gap grows or, for an accepted exception, once its review date has passed. Each open item offers concrete actions with their money consequence (section 3.8).

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

- Pax8 credits and replacement invoices appear as their own lines or invoices; they are not yet netted against the original charge.
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
| Billing run | `src/services/billing-run.ts`, `src/app/(app)/billing/run/` |
| Draft invoices and Xero | `src/services/xero.ts`, `src/connectors/xero/`, `src/app/(app)/billing/` |
| Contracts and revenue summaries | `src/services/contracts.ts`, `src/lib/money.ts`, `src/components/lines-editor.tsx` |
| Pax8 | `src/services/pax8.ts`, `src/connectors/pax8/`, `src/components/subscriptions-panel.tsx` |
| NinjaOne and the discrepancy engine | `src/services/ninjaone.ts`, `src/connectors/ninjaone/` |
| 20i | `src/services/twentyi.ts`, `src/connectors/twentyi/` |
| Better Proposals | `src/services/proposals.ts`, `src/connectors/betterproposals/` |
| Outbound ledger, links, conflicts | `src/services/integrations.ts` |
| Schema | `src/db/schema/sales.ts` (contracts), `xero.ts`, `pax8.ts`, `ninjaone.ts`, `hosting.ts` |
| Longer docs | `docs/integrations.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/phases.md` |
