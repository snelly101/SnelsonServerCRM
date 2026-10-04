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

Not built. NinjaOne, Pax8 and 20i each map to a contract line independently. Bundles and "intentionally free" are not representable; every unmapped item reads as *not billed*. Release 2. The NinjaOne note about several lines comparing against the same organisation count is a real limitation: lines without a site all compare against the whole organisation.

## Brief section 4: supplier cost through to customer billing

Pax8 reconciliation exists at invoice level. Charge-level allocation, historical import by date range, "outside imported history" versus "no bill", and the finding table (supplier charge without customer, covered service without expected charge, expected charge missing from Xero…) are release 2.

## Brief section 5: exception-focused workspace

The billing run page lists ready and skipped contracts with a net figure. No comparison with the previous invoice, no change explanations per customer, no batch approval. Release 3.

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

## Brief sections 7 to 9

Renewal exposure against supplier commitments, price reviews, customer-facing explanations, portal and staged automation: releases 3 and 4. Not started.

## Decisions taken while building

- Price changes apply from the next period that starts on or after their effective day and are never pro-rated. Pro-rating a price change inside an advance-billed period would need a credit line against an invoice already issued, which the brief reserves for explicit policies.
- `previous_quantity` and `quantity_changed_on` stay on `contract_lines` for one release (unused) so a rollback keeps the last pending change; they are dropped in a later migration.
- The settlement marker on a change is traceability, not a calculation input: the engine always computes from the full history plus what the previous draft billed.

## Documentation corrections

- `docs/billing-overview.md` section 3.6 now states that `xero_invoices` holds sales invoices plus the purchase bills of the chosen Pax8 supplier contact, and section 3.3 / 4.3 describe the dated history instead of the single pending change.
