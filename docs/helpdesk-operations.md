# Helpdesk operations runbook

How to keep the helpdesk healthy day to day, what the jobs do, how to recover, how data is retained and removed, and how to roll a stage back. The mailbox specifics (permissions, scoping, mail flow) are in [helpdesk-m365.md](helpdesk-m365.md).

## 1. Daily checks (two minutes)

1. **Settings → Helpdesk → Operations**: the banner is green, or lists what needs attention. The same facts are in `GET /api/health` under `helpdesk`, so an uptime monitor pointed at `/api/health` already alerts on them.
2. **Needs review** queue (`/helpdesk/tickets?view=review`): unknown senders, unmatched replies, bounces. Link the right contact or merge; every item there was held back on purpose.
3. **Mailbox page** (Settings → Helpdesk → Support mailbox): *inbound dead* and *outbox unknown/failed* tiles are zero. If not, section 3.

## 2. Jobs and what "healthy" means

| Job | Schedule | Healthy when |
|---|---|---|
| `m365.tick` | every minute | inbound rows leave *pending* within a minute or two; outbox rows go *queued → accepted* |
| `m365.delta` | every 5 min | *last inbound sync* on the mailbox page is under 20 minutes old |
| `m365.subscriptions` | every 30 min | subscription state *active*, expiry in the future |
| `helpdesk.sla` | every 5 min | Operations shows a check within the last 30 minutes while tickets are open |
| `helpdesk.rules` | every 15 min | Operations shows a run; the Automation page's *Recent runs* has no errors |
| `system.retention` | nightly 03:15 | Operations shows last night's counts |

The worker container must be running for any of this; `docker compose ps` and the Integrations page heartbeat confirm it.

## 3. Queues, replay and recovery

- **Inbound row dead**: open it on the mailbox page. The error names the message id and the failure (parse, attachment store, scan, database). Fix the cause (disk full, ClamAV down, a Graph shape difference) and press **Replay**; replays are safe because duplicates are detected by provider id and Message-ID.
- **Outbox row unknown**: the send timed out after a draft id was recorded. **Retry** first checks whether the draft still exists in Drafts; if it left, the row is marked accepted, otherwise it sends. Nothing is sent twice.
- **Outbox row failed**: the error is on the row and flagged on the ticket. Retry after fixing (expired credential, throttling, recipient rejected). **Cancel** a row that must not go out.
- **Mailbox status *expired***: an auth failure. Renew the client secret or certificate in Entra, then *Reconnect* on the mailbox page with the new credential.
- **Subscription *missing* or *error***: press **Renew subscription**; if Graph refuses, check `APP_URL` is the public HTTPS address and the webhook route answers (`curl -i "https://crm.example.com/api/webhooks/m365?validationToken=x"` returns the token as text).
- **Missed mail** (webhooks dropped): **Sync now** walks the delta query; mail received before the import cutoff is never imported.
- **Rule misbehaving**: deactivate it (Automation → Edit → Active off); its past runs stay in the log and on the tickets. A rule chain stops after three steps by itself.
- **SLA deadlines look wrong**: open the ticket's *Clock history* under SLA. Every deadline is explained by its events (start, pause, resume, policy change). Editing a policy recomputes every open ticket.

## 4. Retention and anonymisation

Nightly (`runHelpdeskRetention`, inside `system.retention`):

| Data | Kept |
|---|---|
| Inbound queue rows that finished (done/skipped/dead) | 90 days |
| Outbox rows that finished (accepted/cancelled/failed) | 90 days |
| Read notifications | 90 days |
| Automation run log | 90 days |
| Abandoned drafts | 30 days after last save |
| Closed or cancelled tickets | forever; **anonymised** after `HELPDESK_ANONYMISE_AFTER_DAYS` (unset or 0 = never) |
| Open tickets, events, time entries, audit | forever |

**Anonymising a ticket** removes the requester's name, e-mail and contact link, all participants except staff followers, sender/recipient addresses on every message, HTML bodies and quoted text, custom fields, and every attachment (files deleted from the `appdata` volume). It keeps message text, internal notes, events, time entries and the SLA outcome, so reports and statistics stay correct. It is audited (`ticket.anonymise`), recorded as an event, and shown as a banner on the ticket. It cannot be undone.

- **Policy decision for go-live**: set `HELPDESK_ANONYMISE_AFTER_DAYS` in `.env` (for example `730` for two years) and restart. Leave it unset to keep identities until asked.
- **Data-subject request** (right to erasure): Settings → Helpdesk → Operations → *Anonymise their tickets* with the person's e-mail. Every ticket they raised, open or closed, is anonymised. The CRM contact itself is archived or deleted separately (Contacts).
- **One ticket now**: the *Anonymise* button on the ticket page (helpdesk administrators).
- Message text can still contain personal data the requester typed; that is a manual edit.

## 5. Permissions recap

| Role | helpdesk.read | helpdesk.agent | helpdesk.manage | helpdesk.admin |
|---|---|---|---|---|
| Read-only, sales, finance | ✓ | | | |
| Technician | ✓ | ✓ | | |
| Account manager | ✓ | ✓ | ✓ | |
| Admin | ✓ | ✓ | ✓ | ✓ |

`agent`: work tickets, reply, notes, time, checklists, link articles and devices, write draft articles. `manage`: queues, bulk actions, assign others, merge/split, exports, templates, publish articles and mark them customer-visible. `admin`: mailbox, SLA policies, automation rules, categories, operations, anonymisation, article deletion. Internal notes are never e-mailed and never inserted into customer replies; internal-only articles are refused for customer messages in the service layer.

## 6. Rollback

Migrations are additive (new tables and columns only), so the database can stay on the newer schema while an older image runs.

| To roll back | Do |
|---|---|
| Stage 4 (knowledge base, assets, retention, operations) | Deploy the previous image (`git checkout <tag> && docker compose up -d --build`). Articles and links stay in the database untouched. `HELPDESK_ANONYMISE_AFTER_DAYS` is ignored by older images. Anonymisation already applied is permanent. |
| Stage 3 (SLA, rules, notifications) | Previous image. To stop rules and SLA warnings without rolling back, deactivate the rules and delete the default policy. |
| Stage 2 (mailbox) | *Disconnect* on the mailbox page first (removes the Graph subscription and wipes the credential), then the previous image. Queued outbox rows are not sent by older images; cancel them first if they must not go. |
| Stage 1 (helpdesk) | Previous image; the Helpdesk section disappears. Tickets stay in the database. |

Always take a backup (`deploy/backup.sh`) before rolling forward or back, and include the `appdata` volume (attachments) in it.

## 7. Known limitations

- Live Microsoft 365 verification: exercised through the in-memory Graph double; the first live connection was used to correct the connect check (inbox read rather than user object). Watch the inbound queue on the first real messages.
- Knowledge search is word matching (`ILIKE`), not ranked full-text search; suggestions use the subject only.
- Article bodies use the safe Markdown subset (headings, lists, bold, italic, code, links); no tables or images.
- Device links depend on the NinjaOne mirror; devices unmapped from a company cannot be linked to that company's tickets.
- Anonymisation does not rewrite message text.
- No customer portal, no Outlook e-mail commands, no satisfaction surveys (backlog).
