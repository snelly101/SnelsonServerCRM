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

**Built in 1A:** `contract_line_changes` (value before and after, effective day, actor, reason, the draft that first accounted for it). The engine reconstructs the quantity on any day and charges each increase for its own days; decreases are still not credited in-period (policy work is 1B). Catch-up is the difference between what the previous period should have cost and what its draft billed for the line, so a draft prepared after the change never double-bills. Every engine-produced draft line carries `calc`, shown on the draft page as *How these amounts were calculated*. The contract page shows pending changes per line and a *Change history* card. Cancelling a draft hands its changes back. Existing pending changes were migrated into the history (`0018`).

## Brief section 2: commitment, price basis, invoice schedule

| Finding | Status | Release |
|---|---|---|
| Lines are converted to the contract's frequency (an annual domain on a monthly contract bills a twelfth each month) while the headline figures describe lines billed on their own cycle | **Confirmed inconsistency** | 1B |
| One global rule for decreases (never credited in-period) | Design limitation | 1B: per-line reduction policy (next period, immediate credit, at renewal) with next period as the migrated default |
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
| No billing commencement / cutover date; only the current period is proposed, so earlier missed periods are invisible | Design limitation | 1B |
| Drafts are not marked stale when the contract changes after preparation | **Confirmed gap** | 1C |
| A hand-typed period that is not an anchored one is billed whole, not pro-rated | **Confirmed defect** | 1C |
| Approval sets `approved` before the outbound call without an atomic claim; the outbound ledger's row lock stops a true duplicate, but two clicks can both reach the ledger | Design limitation | 1C: claim the row (`draft`/`failed` → `approved`) in one statement |
| Changes made directly in Xero to a CRM-created invoice are mirrored but not compared with the approved version | Design limitation | 1C |
| Credits and corrections are not modelled | Future capability | 2/3 |

## Brief sections 7 to 9

Renewal exposure against supplier commitments, price reviews, customer-facing explanations, portal and staged automation: releases 3 and 4. Not started.

## Decisions taken while building

- Price changes apply from the next period that starts on or after their effective day and are never pro-rated. Pro-rating a price change inside an advance-billed period would need a credit line against an invoice already issued, which the brief reserves for explicit policies.
- `previous_quantity` and `quantity_changed_on` stay on `contract_lines` for one release (unused) so a rollback keeps the last pending change; they are dropped in a later migration.
- The settlement marker on a change is traceability, not a calculation input: the engine always computes from the full history plus what the previous draft billed.

## Documentation corrections

- `docs/billing-overview.md` section 3.6 now states that `xero_invoices` holds sales invoices plus the purchase bills of the chosen Pax8 supplier contact, and section 3.3 / 4.3 describe the dated history instead of the single pending change.
