# Backlog

Ideas and requests not yet scheduled. Each item states what it is, why, and the decisions it needs before building. Move an item into `docs/phases.md` when it is picked up.

## Customer password / credentials vault

**Status:** architecture proposed in [`docs/secure-vault-plan.md`](secure-vault-plan.md); awaiting the decisions listed there.

**What:** a per-customer section holding shared credentials the MSP needs to support that customer (router admin, M365 global admin break-glass, portal logins, Wi-Fi keys), with a title, username, secret, URL, notes and a "last rotated" date.

**Why:** technicians keep these in spreadsheets or a separate password manager today; having them beside the customer record saves lookups and keeps an audit trail of who viewed what.

**Design notes and decisions needed:**
- The original build brief excluded storing customer passwords and remote-access credentials. Building this reverses that decision, so it needs an explicit go-ahead and a short data-handling policy (who may view, retention, what happens when a customer leaves).
- Secrets encrypted at rest with a **separate** key from the integration-credential key, so a leaked `APP_ENCRYPTION_KEY` does not expose customer secrets and the two can be rotated independently.
- Reveal-on-click only, never rendered in the page by default; every reveal written to the audit log with user, customer and item; copy-to-clipboard with auto-clear.
- New permission `credential.read` / `credential.write`, granted to admin and technician only by default; read-only and sales roles never see the section.
- Optional per-item "restricted" flag limiting reveal to admins.
- Search excludes secret values. CSV export excludes the section entirely.
- Backups already encrypt the database dump; document that the vault key must be backed up separately like the encryption key.
- Out of scope for the first version: browser extension, sharing links, TOTP seeds.

## Customer notes section

**What:** a free-form, rich-text notes area on the company page for standing information about the customer (site access instructions, escalation contacts, preferences, quirks), distinct from the dated activity timeline.

**Why:** the timeline is for events; there is no place for "things to know" that stay current.

**Design notes:**
- One notes document per company, edited in place with a simple formatting toolbar (headings, lists, bold, links), stored as sanitised HTML or Markdown.
- Shows "last edited by / when"; every save audited with a field diff so changes can be traced.
- Optional pinned notes that also appear at the top of the Overview tab.
- Visible to all roles that can read the company; editable by roles with `company.write`.
- Later: per-site notes and per-contact notes using the same component.

## Earlier ideas parked

- Creditsafe credit checks via Creditsafe Connect (manual "Run credit check" on the company page, score/limit/band history, optional scheduled refresh). Needs a Connect API subscription; each report consumes credits.
- Bulk "Activate imported drafts" button on the Contracts page for contracts created from Xero repeating invoices.
- Weekly and every-N-months Xero repeating invoices converted to a monthly-equivalent contract line with the true cycle noted.
