# Backlog

Ideas and requests not yet scheduled. Each item states what it is, why, and the decisions it needs before building. Move an item into `docs/phases.md` when it is picked up.

## Customer password / credentials vault

**Status:** built (Phase 7, see `docs/phases.md`). Remaining from the plan: external KMS for the master key, SSH private keys as a secret kind.

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

**Follow-up: plain-text backup export of everything in the vault**

**What:** an admin-only "Export vault" action that decrypts every item (including archived) and produces a readable backup, CSV and JSON, holding title, category, company, username, secret, URL, notes, TOTP seed, tags, rotation dates and archive state. Intended for disaster recovery (loss of the master key or the database) and for migrating to another tool, not for day-to-day use.

**Why:** the vault is only as recoverable as the master key. A periodic offline plain-text copy, kept in the password manager or a sealed envelope, means a lost key or a corrupted database does not lose every customer credential.

**Design notes and decisions needed:**
- Requires `vault.admin`, a fresh step-up, and a second admin's confirmation (or a typed acknowledgement) because the output is every secret in clear.
- Every export written to the vault audit chain with row count and file hash; an urgent task is created for the other admins so an export is never silent. Counts against a separate, tighter rate limit (for example one per hour).
- Output offered two ways: a plain CSV/JSON download for offline storage, and the same content wrapped in a password-protected archive (7z/AES or age) so the browser download is not itself clear text. Decide whether plain download is allowed at all or only the encrypted archive with the passphrase spoken separately.
- Companion "Import vault backup" so the export format round-trips, used when re-keying after a lost master key.
- Optional scheduled export to the backup volume, encrypted with a public key held offline, to avoid relying on someone remembering to run it.
- Document the procedure in `docs/deployment.md` next to key custody.

## Two-factor authentication for CRM sign-in

**Status:** built (Phase 9, see `docs/phases.md`): authenticator app + recovery codes, trusted browsers, per-role policy with grace period, admin reset. Not yet: passkeys, TOTP as a vault step-up alternative.

**What:** a second factor on every staff login: authenticator app (TOTP) as the baseline, with recovery codes; optionally passkeys/WebAuthn and an admin switch to make it mandatory per role.

**Why:** the CRM now holds customer credentials (Secure Vault) and financial data; a phished or reused staff password should not be enough on its own.

**Design notes:**
- Better Auth's `twoFactor` plugin provides TOTP enrolment, verification and backup codes on the existing session model; the CRM already has an RFC 6238 implementation (`src/lib/totp.ts`) if a custom path is preferred.
- Enrolment under the user's profile: QR code + manual key, verify one code, download recovery codes (shown once). Admins can reset a user's second factor from Settings → Users; the reset is audited.
- Enforcement: setting "require 2FA for roles: admin, technician, finance" with a grace period; users without it are sent to enrolment after sign-in. Microsoft SSO users inherit Entra's MFA and can be exempted per policy.
- The vault step-up could accept a TOTP code as an alternative to the password once 2FA exists.
- Remember-device option (30 days, cookie bound to the browser) to keep it tolerable day to day.

## Photos and file attachments on a company

**What:** attach photos and documents to a company (and later a site or vault item): comms cabinet photos, floor plans, contracts, network diagrams. Thumbnail grid on the company page, full-size viewer, download, delete, who uploaded and when.

**Design notes:**
- Storage outside the database: S3-compatible object storage (Backblaze B2 / Cloudflare R2, both already suggested for backups) with the bucket private and files served through short-lived signed URLs. Local disk on the VPS as a fallback for small installs, mounted as a Docker volume and included in the backup script.
- `attachments` table: entity type/id, filename, MIME type, size, storage key, checksum, uploaded by, uploaded at, optional caption and tags; EXIF stripped and images resized for thumbnails on upload; virus-scan hook optional.
- Upload from the browser straight to storage via a pre-signed PUT so large photos don't pass through the app server; limits per file (e.g. 25 MB) and per company.
- Permissions follow the company (`company.read` to view, `company.write` to add/delete); deletion audited; retention follows the company archive.
- Phone-friendly: camera capture on mobile browsers so engineers can photograph a cabinet on site and attach it in two taps.

## Helpdesk with email-in / email-out via the engineers' Microsoft 365 mailboxes

**What:** a full ticketing system inside the CRM: tickets raised by customers by email (and by staff in the UI), threaded conversations, assignment, status, priority, SLA timers, internal notes, linkage to company, contact, site, device and contract, and a queue view. Engineers reply and update tickets from the CRM **or by replying from their own Office 365 mailbox**, and customers receive replies from the engineer's address.

**Why:** closes the loop between sales/contracts and day-to-day support, and keeps support history on the customer record beside contracts, devices and the vault.

**Architecture notes (Microsoft Graph, no IMAP/SMTP):**
- Register one Entra app with delegated Graph permissions `Mail.ReadWrite`, `Mail.Send`, `offline_access`; each engineer connects their mailbox once via OAuth (the CRM already has the Microsoft SSO app registration pattern). Tokens stored encrypted like the other integrations, refreshed by the worker. A shared support mailbox (e.g. support@) is connected the same way, or via application permissions restricted with an Exchange application access policy.
- **Inbound:** Graph change notifications (webhooks) on each connected mailbox's Inbox with a 3-day subscription renewed by the worker, plus a periodic delta sync as the safety net (same pattern as Xero webhooks + hourly sync). New mail to the support address, or to an engineer where the subject carries a ticket key, becomes a ticket or a ticket message.
- **Threading:** every outbound mail carries a ticket key in the subject (`[SS-1234]`) and a custom Internet header; replies are matched on `In-Reply-To`/`References` first, subject key second, sender + recent ticket third. Quoted history and signatures are trimmed with a reply parser.
- **Outbound:** a reply written in the CRM is sent through the assigned engineer's mailbox with Graph `sendMail`, so the customer sees the engineer's address and the sent item lands in the engineer's Sent folder. An engineer replying from Outlook is captured by the inbound sync (the Sent folder is also watched) and attached to the ticket as their reply.
- **Commands by email:** an engineer can change status/assignee from Outlook with a first-line command (`#close`, `#assign alex`, `#priority high`), validated against the sender being a connected, verified mailbox.
- Attachments stored with the attachments feature above; inline images rewritten to signed URLs.
- Data model: `tickets`, `ticket_messages` (direction, channel email/portal/internal, raw headers, body html/text, message-id), `ticket_participants`, `ticket_events` (status/assignment changes), `mailboxes` (per-user Graph connection, subscription id, delta token), `sla_policies`. Ticket numbers are a sequence.
- UI: Helpdesk queue (mine / unassigned / all, filters by status, priority, SLA breach), ticket page with conversation, internal notes, side panel showing the customer's contract, devices and vault link, and a "Tickets" tab on the company and contact pages. Dashboard and Reports gain open tickets, SLA breaches and response times.
- Customer-facing: auto-acknowledgement with the ticket key; optional read-only portal later.
- Decisions needed before building: which addresses receive tickets (shared support mailbox only, or engineers' addresses too); SLA definitions per contract; whether customers may see internal notes (no by default); retention of raw email; whether NinjaOne alerts should also create tickets.
- Effort: the largest item on the backlog, roughly the size of Phases 3 to 5 combined; sensible to split into (1) tickets + queue + UI-only replies, (2) Graph mailbox connection and inbound email, (3) engineer replies from Outlook and email commands, (4) SLAs and reporting.

## Customer notes section

**Status:** built (Phase 10, see `docs/phases.md`): multiple notes per company with Markdown formatting, pinned notes on Overview, audited edits, soft archive. Later: per-site and per-contact notes.

**What:** a free-form, rich-text notes area on the company page for standing information about the customer (site access instructions, escalation contacts, preferences, quirks), distinct from the dated activity timeline.

**Why:** the timeline is for events; there is no place for "things to know" that stay current.

**Design notes:**
- One notes document per company, edited in place with a simple formatting toolbar (headings, lists, bold, links), stored as sanitised HTML or Markdown.
- Shows "last edited by / when"; every save audited with a field diff so changes can be traced.
- Optional pinned notes that also appear at the top of the Overview tab.
- Visible to all roles that can read the company; editable by roles with `company.write`.
- Later: per-site notes and per-contact notes using the same component.

## 20i hosting: follow-ups

**Status:** Phase 8 built the read-only mirror, company linking, billing-line link, related invoices and expiry reminders.

- SSL certificate inventory once the listing endpoint shape is confirmed on the live account (`hosting_items.kind = ssl` is reserved).
- Reconcile 20i's charges to the reseller (domain and package renewals) against what the customer's contract line bills, to surface hosting margin leaks.
- Write actions behind confirmation and audit: renew a domain, create a mailbox or reset its password, suspend a package for non-payment, edit DNS from the company page.
- Helpdesk sidebar showing the sender's hosting and mailbox state once the email helpdesk exists.

## MRR shown for annually billed lines

**What:** contract and company headers show an MRR figure that includes lines billed annually (or quarterly), normalised to a monthly amount. Nothing is invoiced monthly for those lines, so the number reads as cash that is not arriving each month.

**Why:** the header figure is used as "what we bill this customer a month"; an annual licence renewal inflates it and misleads whoever is checking invoices against it.

**Design notes and decisions needed:**
- Decide what the headline should be: (a) true monthly billing only (annual lines excluded, shown separately as "billed annually: £X/year"), (b) keep normalised MRR but label it "annualised recurring ÷ 12" with the annual lines listed underneath, or (c) show both, monthly billing and normalised MRR, side by side.
- Reports → MRR uses the normalised figure for forecasting; that view should keep the formula and say so, whichever headline the contract page adopts.
- Xero invoice comparison on the company page should compare against what is actually invoiced per period, not the normalised figure.

## Helpdesk customer portal

**What:** an authenticated customer-facing portal for the helpdesk (deferred from the helpdesk build): customers create tickets, see their own permitted tickets, add replies and attachments, follow status and the public conversation, search published customer-visible knowledge articles, and give optional satisfaction feedback after resolution. Designated company administrators may see their company's tickets only when explicitly authorised.

**Why:** email covers most customer interaction; a portal adds self-service and visibility for larger customers without another inbox.

**Design notes and decisions needed:**
- Needs a customer identity: the CRM has no customer authentication today, so this means a separate Better Auth user type (or magic-link sign-in bound to a verified contact email) with its own session scope, never staff roles.
- Customers must only ever see: their own tickets (or the company's when the contact is a company administrator), public messages, customer-visible attachments, published customer-visible articles. Internal notes, time entries, restricted attachments and other customers' data are never queryable from portal code paths; enforce at the service layer with a portal-specific query surface and cover it with the "internal notes never leak" acceptance test.
- Ticket `source = portal` already exists in the data model; the knowledge base already carries a customer-visible flag.
- Decisions: who invites customers (agents from a contact record), whether company administrators are a contact flag or a separate grant, rate limits and attachment limits for anonymous-adjacent traffic, and whether satisfaction feedback is portal-only or also sent by email link.

## Pax8 integration (Microsoft 365 and other cloud subscriptions)

**Status:** built (Phase 12, see `docs/phases.md`): read-only mirror of companies, subscriptions, products and recent invoices; company linking; line matching by choice / SKU / name; licence discrepancies; Pax8 price as line cost. Remaining from the plan: write actions (quantity changes behind confirmation and audit), Pax8 invoice vs Xero bill reconciliation.

**What:** connect the Pax8 Partner API so each customer's subscriptions (Microsoft 365 licences, Acronis, security add-ons) are mirrored against the CRM company, with quantities, unit cost, billing term and renewal dates.

**Why:** licence counts drift between Pax8, the customer's contract and the Xero invoice. Seeing all three side by side catches under-billing the same way the NinjaOne device comparison does.

**Design notes and decisions needed:**
- Pax8 Partner API: OAuth client-credentials (client id/secret from the Pax8 portal), `GET /companies`, `GET /subscriptions`, `GET /products`, `GET /invoices` and invoice items. Entered in the Integrations UI, stored encrypted like the other connectors.
- Read-only first: mirror companies and subscriptions, link Pax8 companies to CRM companies (same mapping table pattern as NinjaOne/20i, with domain and name suggestions), show a **Subscriptions** tab on the company page.
- Compare subscription quantity with the matching per-user contract line (product matched by SKU) and raise review items for differences, reusing the discrepancy engine; billing is never changed automatically.
- Cost side: Pax8 partner cost per licence feeds contract line unit cost so margin on the Contracts page is real, not the catalogue estimate.
- Later, write actions from the CRM (increase or decrease a licence quantity) behind confirmation and audit; they are customer-billable changes so they need the same care as vault reveals.
- Decisions: which subscriptions are in scope (all vs Microsoft only), whether Pax8 invoices should be reconciled against Xero bills, and who may adjust quantities.

## Dark mode

**Status:** built (Phase 11, see `docs/phases.md`): system / light / dark per user, palette remapped under `[data-theme="dark"]`, sidebar unchanged, print forces light.

**What:** a dark theme for the whole app with a three-way setting per user (system, light, dark) in the user menu, remembered across devices.

**Why:** engineers work in dark IDE/RMM consoles and late shifts; the current light-only UI is the odd one out.

**Design notes:**
- Tailwind 4 `@custom-variant dark` keyed on a `data-theme` attribute on `<html>`, set before paint by an inline script from a cookie to avoid a flash; `color-scheme` follows it so native controls match.
- Replace the ~400 hard-coded `bg-white` / `slate-*` utilities in `src` with semantic tokens (`bg-surface`, `text-fg`, `border-line`, `bg-muted`) defined once in `globals.css` for both themes, so future components pick up both themes automatically. Brand colours stay, with lighter tints for dark surfaces.
- Component sweep: tables, cards, dialogs, badges, forms, toasts, charts (Recharts axis and grid colours), the sidebar, and the vault reveal box, which must keep high contrast.
- Preference stored on the user record and mirrored to a cookie; "system" honours `prefers-color-scheme`.
- Print stylesheet forces light.
- Playwright screenshot pass in both themes on the main pages to catch missed colours.

## Move helpdesk settings into the main Settings section

**What:** the helpdesk's administration pages (teams, categories, support mailbox, SLA policies and business hours, automation rules, templates, operations) currently live under Helpdesk → Administration. Move them under the main **Settings** section (Settings → Helpdesk, with its own sub-navigation) so every configuration screen in the CRM is in one place, and leave the Helpdesk section for day-to-day work only.

**Why:** administrators expect all set-up in Settings; the split puts helpdesk configuration where agents work and hides it from the usual settings path.

**Design notes:**
- Routes move from `/helpdesk/admin/*` to `/settings/helpdesk/*` with redirects from the old paths so bookmarks and the runbook keep working.
- Permission checks stay as they are (`helpdesk.admin` for mailbox, SLA, rules, operations; `helpdesk.manage` for templates); the Settings navigation shows the helpdesk group only to roles that hold them.
- Keep small contextual links where agents need them (the SLA panel's link to the policy, the composer's link to templates, the mailbox queue links from Operations).
- Update `docs/helpdesk-m365.md` and `docs/helpdesk-operations.md` paths, and the browser tests that navigate to the admin pages.

## Earlier ideas parked

- Creditsafe credit checks via Creditsafe Connect (manual "Run credit check" on the company page, score/limit/band history, optional scheduled refresh). Needs a Connect API subscription; each report consumes credits.
- Bulk "Activate imported drafts" button on the Contracts page for contracts created from Xero repeating invoices.
- Weekly and every-N-months Xero repeating invoices converted to a monthly-equivalent contract line with the true cycle noted.
