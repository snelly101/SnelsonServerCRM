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

## Two-factor authentication for CRM sign-in

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
