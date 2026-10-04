# Billing improvement plan

Working plan for the billing improvement brief (`billing-improvement-brief-for-claude.md`), mapped against the implementation as inspected in the code, not only the overview. Each item is marked **confirmed defect**, **design limitation** or **future capability**, with the release it lands in. Releases are built as usable vertical slices, one pull request each, and this file is updated as they merge.

## Baseline that stays

- Xero is the system of record for issued invoices, payments and balances; CRM approval creates Xero **drafts** only.
- Shared calculation engine (`src/lib/billing.ts`) behind both the billing run and *Prepare invoice*.
- Role permissions, audit log, company timeline, integration field ownership and the outbound ledger.
- Pax8 invoice vs Xero bill reconciliation with durable manual matches; purchase bills stay out of sales lists and revenue totals.
- Demo adapters, clearly labelled, never writing to real suppliers.

## Brief section 1: permanent billing history

| Finding | Status | Release |
|---|---|---|
| One `previous_quantity` / `quantity_changed_on` per line: a second change before invoicing kept the first date and lost the middle value, so three changes in a month were billed as one from the first date (over- or under-charging the days between) | **Confirmed defect** | 1A, built |
| Preparing a draft cleared the pending change; cancelling that draft lost it for good | **Confirmed defect** | 1A, built |
| No record of who changed what, when or why beyond the audit diff | Design limitation | 1A, built |
| Invoice lines carried only text; the inputs behind an amount were not kept | Design limitation | 1A, built |
| Price changes were silent (no history, applied to whatever period came next) | Design limitation | 1A, built: dated, applied from the next period starting on or after the effective day |
| Backdated change more than one period back is not caught up automatically | Design limitation | later: needs coverage per period (1B) to know which invoice to adjust |

**Built in 1C:** the *Prepare invoice* dialog shows the calculated lines, net and any already-drafted periods for the chosen dates before anything is created, so a partial period or a double-up is visible up front.

**Built in 1B** (`src/services/billing-coverage.ts`): planning of what each contract owes on a run date, per line and per period; the billing run and *Prepare invoice* both build from it, so a manual period that is not an anchored one is now pro-rated like any other partial period rather than billed whole. The draft's period columns span the items it carries; its description says when missed periods are included.

**Built in 1A:** `contract_line_changes` (value before and after, effective day, actor, reason, the draft that first accounted for it). The engine reconstructs the quantity on any day and charges each increase for its own days; decreases are still not credited in-period (policy work is 1B). Catch-up is the difference between what the previous period should have cost and what its draft billed for the line, so a draft prepared after the change never double-bills. Every engine-produced draft line carries `calc`, shown on the draft page as *How these amounts were calculated*. The contract page shows pending changes per line and a *Change history* card. Cancelling a draft hands its changes back. Existing pending changes were migrated into the history (`0018`).

## Brief section 2: commitment, price basis, invoice schedule

| Finding | Status | Release |
|---|---|---|
| Lines are converted to the contract's frequency (an annual domain on a monthly contract bills a twelfth each month) while the headline figures describe lines billed on their own cycle | **Confirmed inconsistency** | 1B, built: each line has an **invoice schedule**. *With the contract* (the migrated default, so existing agreements are unchanged) keeps spreading the price over the contract's invoices; *own cycle* invoices the line once per its own period, anchored like the contract. The brief's "£120 a year, invoiced £10 monthly" is the first; a domain renewed yearly is the second |
| One global rule for decreases (never credited in-period) | Design limitation | 1B, built: per-line **reduction policy**: lower quantity from the next period (migrated default), credit the unused days (negative line, also as a catch-up), old quantity until the contract's renewal date |
| Separate customer and supplier commitment, charging in advance or arrears | Future capability | 4 |
| Month-end anchors, leap years, rounding | Covered by tests; leap-day test added in 1A | — |

## Brief section 3: central service register

**Built in 2A** (`src/services/service-register.ts`, `service_coverage`, migration `0020`): every service the integrations report for a customer (Pax8 subscriptions, 20i packages and domains, NinjaOne managed devices) appears on the company's **Services** tab and on Billing → **Services** with one of seven states. *Charged* and *unmapped* are derived from the existing billing-line mappings; *bundle*, *commitment*, *free* (reason and review date), *internal* and *investigate* are explicit decisions recorded with who made them and why. The engines respect them: a bundled Pax8 subscription counts toward its bundle line in the licence check, free / internal / commitment-covered ones count toward nothing, 20i's "linked but not billed" and Pax8's "not billed" leave decided items out, and devices marked internal or free are left out of the billable count and the device check (per-device control on the Devices tab).

The NinjaOne finding was real: several per-device lines of one contract without a site each compared against the whole organisation count. Lines of one contract that share a scope now compare together (contracted = the sum, one review item naming all of them); items left on the other lines are closed.

Still open from this section: dated mappings (a service moving from one line to another keeps only the current mapping), explicit allocation rules for a resource backing several charges, and renewal-schedule coverage for domains beyond the renewal date shown. Release 2B/2C.

## Brief section 4: supplier cost through to customer billing

**Built in 2B** on top of the invoice-level reconciliation:

- **Matching basis in plain language.** Each match is stored as *by reference* (strong), *by amount and date* (weaker, shown in amber) or *by hand*; a hand decision is never replaced. Identifier matching requires the whole id as a token, so a longer number that merely contains it cannot match.
- **Charge-level allocation.** Every Pax8 invoice line is tied to the customer (through the Pax8 company link) and the subscription (through the Pax8 product), with the findings *no customer*, *no matching subscription*, *price differs from subscription* and *quantity differs* (informational). The reconciliation table shows lines, unallocated money and price findings per invoice; a detail page per invoice lists the charges by customer. A Xero bill with line detail is compared line by line by amount; a one-line bill is reported as total-matched only, never as reconciled line by line.
- **Imported history.** The card states the stretch of Pax8 invoices held and when they were last fetched. Supplier bills older than the imported history are listed as *outside imported history*, not as a finding. **Import invoices from a date** (admin) brings older invoices and their charge lines in through the same upsert as the sync, so nothing is duplicated and existing hand matches survive; once imported, invoices stay even though the routine sync only refreshes the last N.
- Older unresolved rows stay visible because mirror rows are never deleted.

**Built in 2C** (`src/services/billing-findings.ts`, Billing → **Exceptions**): the brief's finding table read across the register, the coverage planner, the drafts, the Xero mirror and the Pax8 reconciliation, each with the interpretation the brief gives and a link to where it is resolved: service without commercial coverage (potential missed revenue), free arrangement past review, covered service without an expected charge (its line is on a non-active contract or has quantity 0), expected charge not yet drafted (what the billing run would propose, missed periods in red), draft waiting more than a week, customer invoice changed in Xero after approval, supplier charge differing from expectation (invoice vs bill, charge vs subscription price, bill with no invoice), supplier charge without a customer, and sales invoices raised in Xero outside the CRM (informational). Potential leakage (unmapped) is kept apart from confirmed gaps. Credits and replacement Pax8 invoices are still shown as their own lines rather than netted against the original.

## Brief section 5: exception-focused workspace

**Built in 3A** (`src/services/billing-workspace.ts`, Billing → **Monthly run**): the run page opens with the brief's one-line summary (contracts ready, needing review, blocked; expected billing; potential missed revenue across unmapped services; renewals and notice deadlines in the next seven days) and each contract is compared with its **previous comparable draft** (the one ending the day before the period, else the latest earlier one). The difference is explained in plain language from the calculated lines, never guessed: quantity and price changes per line, new and removed lines (a re-created line with the same description reads as a change), pro-rated additions, credited reductions, catch-ups, missed periods and lines due on their own cycle. Rows are **ready** (Xero-linked, unchanged, nothing open; ticked by default), **need review** (changed amount, open discrepancies with the unbilled amount, unmapped services with their monthly cost, Pax8 or NinjaOne data older than three hours, missed periods, first invoice) or **blocked** (no Xero contact link; cannot be ticked). The Findings page (2C) remains the cross-cutting exception list.

**Built in 3B** (`src/services/draft-review.ts`, Billing → Monthly run → *Approve*): every pending draft is reviewed against the previous comparable draft of its contract and is either **unchanged** (contract-sourced, Xero linked, not stale, plain draft, lines identical line for line) or an **exception** with its flags and the *why* reasons. Unchanged drafts are ticked by default and approved together, one after another through the normal single-draft approval with its atomic claim and outbound ledger, each re-checked at the moment of approval so a draft that changed meanwhile is skipped with the reason rather than approved blind. Exceptions keep the one-by-one review.

**Built in 3C** (`src/services/discrepancy-actions.ts`, `src/lib/discrepancy-impact.ts`, migration `0021`): a review item is no longer only accepted or dismissed. Its **Resolve** dialog offers the concrete actions with the money consequence first: amend the contract line to the observed count from a chosen date (a dated change with reason, pro-rated by the engine, linked back from the item), reduce at renewal (lower count, billed at the agreed count until the renewal date), include chosen subscriptions in a bundle line (licence items; the check re-runs at once), accept as an exception with an **owner** and a **review date** (re-opens by itself once the date has passed, noted with the owner), or dismiss. Each action is audited under its own name and posted on the company timeline.

Release 3 is complete. Remaining from the brief: sections 7 to 9 (renewal exposure, price reviews, customer-facing explanations, portal, staged automation) and the future capabilities noted above (separate customer and supplier commitment, credits and corrections, backdated changes more than one period back).

## Brief section 6: invoice lifecycle

| Finding | Status | Release |
|---|---|---|
| No billing commencement / cutover date; only the current period is proposed, so earlier missed periods are invisible | Design limitation | 1B, built: `contracts.billing_from` (*Bill from (CRM)*). With it, every line period from that date with no draft is proposed by the run and flagged **missed**; without it only the current period is proposed, as before |
| Coverage was per draft and per contract period (skip if any draft had that period start) | Design limitation | 1B, built: coverage is per **line period** (`calc.from` of a period or pro-rata line in a non-cancelled draft; older drafts cover their own period), so a run after a cancelled draft, a mixed-cycle contract and a missed-period catch-up all work from the same rule |
| Drafts are not marked stale when the contract changes after preparation | **Confirmed gap** | 1C, built: a draft awaiting approval whose contract (terms, lines or dated changes) changed after it was prepared is marked **stale** on the Finance list and explained on the draft page, with *Re-prepare from the contract* (cancels it, hands its coverage and changes back, prepares a fresh one for the same stretch of periods) |
| A hand-typed period that is not an anchored one is billed whole, not pro-rated | **Confirmed defect** | 1B, built (the manual path goes through the same planner; a partial period is pro-rated) |
| Approval sets `approved` before the outbound call without an atomic claim; the outbound ledger's row lock stops a true duplicate, but two clicks can both reach the ledger | Design limitation | 1C, built: one `UPDATE … WHERE status IN (draft, failed) RETURNING` claims the draft; a second approval gets "being approved already" or the reused result. An approval still in progress after ten minutes is treated as uncertain and may be retried, and the ledger reconciles by reference before any second create |
| Changes made directly in Xero to a CRM-created invoice are mirrored but not compared with the approved version | Design limitation | 1C, built: the draft page and a Finance card *Changed in Xero after approval* show a changed net amount, currency, or a voided / deleted invoice against the approved version |
| Credits and corrections are not modelled | Future capability | 2/3 |

## Brief section 7: margins before renewals and price changes

**Built in 4A** (`src/services/renewals.ts`, Billing → **Renewals & pricing**, migration `0022`): every active contract with a renewal date is queued by its **decision deadline**, a configurable lead (Settings → General, *Renewal decision lead*, default 30 days) before the notice deadline. Each row sets the customer's renewal date against the supplier commitments behind its lines, read from the service register (Pax8 commitment end dates, 20i domain expiries, through matched or bundled lines), and names the mismatches in plain words: *the agreement renews on 31 December but the supplier commitment runs to 30 September* (with the months and supplier cost at stake where the cost is known) or *the supplier commitment renews before the agreement; the cost may change first*. Planned quantities and prices (dated changes after today) are shown. Account managers **record the customer's decision** (renew as is, amend, not renewing with a reason) against that renewal date, audited and on the timeline; moving the renewal date reopens it. **Prepare amendment** opens the contract with changes dated from the renewal date, so the invoice preview shows their effect first. The contract page carries the same card.

**Built in 4B** (`src/services/price-reviews.ts`, Billing → **Renewals & pricing** → Price review, migration `0023`): a price change is proposed by scope (catalogue product or line description), kind (percentage, new unit price, or a supplier cost passed through at the same margin), effective date and reason, and previewed across every affected active line with customer, price and cost now and after, margin now and after, monthly revenue change, the day it applies for that customer and the first invoice period carrying it, and the agreement constraints: **prices fixed until renewal** (new contract term; the change applies from the renewal date), agreement ending first (not applicable), customer not renewing, notice deadline within 30 days. Applying records dated, reasoned unit-price changes line by line (and optionally the catalogue price); nothing is silent. Signed proposals now capture the opportunity's lines at acceptance as the activated terms and flag *terms changed after signature* (plus a mapping conflict) when the opportunity was edited after signing.

**Built in 4C** (`src/lib/customer-explanation.ts`, `src/services/customer-schedule.ts`, migration `0024`): the brief's customer-facing explanation (*Your November charge includes 16 Microsoft licences, plus £10.92 for two licences added on 14 October*) is produced from the calculated lines on every draft, with a printable **customer schedule** (charges grouped by agreement with service dates, the supporting list of licences, devices and domains behind each charge from the register, renewal information). A contract's **purchase order reference** is carried onto its drafts and the first Xero line. The billing run can prepare **one consolidated draft per customer** across several agreements; coverage, change settlement, staleness, re-preparation, cancellation and the Finance review all understand consolidated drafts.

**Built in 4D** (`src/services/billing-automation.ts`, Settings → **Billing automation**, migration `0025`, worker queue `billing.automation`): a three-level policy, default *detect only*. Level 1 prepares drafts for the contracts the workspace rates ready on the run day each month (consolidated per customer when the policy says so); level 2 then creates in Xero the drafts the review finds unchanged, through the normal approval path, leaving every exception for a person. Scheduled daily, acting once a month; runnable by hand by an administrator; every run audited as a system action naming the policy, with the last run's summary on the page. Nothing is ever authorised or sent from Xero by the CRM.

Release 4 is complete. The customer portal and the further billing models in brief section 9 (usage in arrears, allowances and overages, deposits and milestones, delivery-triggered hardware, per-customer currency and tax mappings) remain future work, to be added when the business needs them on the same register, engine and reconciliation.

## Brief sections 8 and 9

Customer-facing explanations and consolidation: 4C (above). Staged automation: 4D (above). Portal and further billing models: future.

## Billing area (structure)

Built after release 4: the eleven billing entry points spread over Finance, Contracts, Devices, the Pax8 page and Settings were joined into one **Billing** sidebar section with a fixed sub-navigation in the order the work flows (Overview with a "what to do next" list; Monthly run as Prepare / Approve / Issued; Exceptions; Services; Renewals & pricing; Invoices with customer and supplier tabs; Automation). No data or calculation changed; old addresses redirect. Each company page gained a **Billing** tab with the same picture narrowed to that customer and its own "what to do next" list.

## Decisions taken while building

- Price changes apply from the next period that starts on or after their effective day and are never pro-rated. Pro-rating a price change inside an advance-billed period would need a credit line against an invoice already issued, which the brief reserves for explicit policies.
- `previous_quantity` and `quantity_changed_on` stay on `contract_lines` for one release (unused) so a rollback keeps the last pending change; they are dropped in a later migration.
- The settlement marker on a change is traceability, not a calculation input: the engine always computes from the full history plus what the previous draft billed.

## Documentation corrections

- `docs/billing-overview.md` section 3.6 now states that `xero_invoices` holds sales invoices plus the purchase bills of the chosen Pax8 supplier contact, and section 3.3 / 4.3 describe the dated history instead of the single pending change.
