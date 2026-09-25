# Helpdesk: Microsoft 365 mailbox setup and operations

The helpdesk receives customer e-mail from one Microsoft 365 mailbox (a user mailbox or a shared mailbox such as `support@yourcompany.co.uk`) and sends replies from it. Everything runs in the background worker with app-only credentials, so mail is processed whether or not an agent is signed in. The data model supports several mailboxes; the UI connects one.

## 1. What the CRM needs from Microsoft 365

| | |
|---|---|
| **Auth** | OAuth 2.0 client credentials (app-only) against `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`. Client secret **or** certificate (client assertion, RS256, `x5t` thumbprint). No mailbox password, no basic auth, no delegated permissions. |
| **Application permissions** | `Mail.ReadWrite` (read the inbox, create drafts, keep Sent Items) and `Mail.Send` (send the drafts). Nothing else. `Mail.ReadBasic` is not enough (no bodies/attachments); `Mail.Read` is not enough (no drafts). |
| **Admin consent** | Required once for both permissions, by a Global Administrator or Privileged Role Administrator in Entra. |
| **Mailbox scoping** | Application permissions are tenant-wide by default. Restrict the app to the support mailbox with an Exchange **application access policy** (`New-ApplicationAccessPolicy -AccessRight RestrictAccess`) or, on tenants where it is available, **RBAC for Applications** (`New-ManagementScope` + `New-ManagementRoleAssignment` with `Application Mail.ReadWrite` / `Application Mail.Send`). Grants are additive: if you use RBAC for Applications **remove** the tenant-wide application permission (or keep it and rely on the access policy), otherwise a scoped role assignment sits beside an unrestricted grant. Check the effective access with `Test-ApplicationAccessPolicy`. |
| **Endpoints used** | `GET /users/{mailbox}` (identity), `GET /users/{mailbox}/mailFolders`, `GET …/mailFolders/{id}/messages/delta` (incremental sync), `GET …/messages/{id}` with `internetMessageHeaders`, `GET …/messages/{id}/attachments`, `POST /subscriptions`, `PATCH /subscriptions/{id}`, `DELETE /subscriptions/{id}`, `POST …/messages` (draft), `POST …/messages/{id}/createReply` / `createReplyAll`, `PATCH …/messages/{id}`, `POST …/messages/{id}/attachments` (< 3 MB) or `createUploadSession` (larger), `POST …/messages/{id}/send`. Every read sends `Prefer: IdType="ImmutableId"` so ids survive folder moves. |
| **Webhook** | `https://<your CRM>/api/webhooks/m365` must be reachable from the internet over HTTPS (Caddy already terminates TLS). Graph validates it with a `validationToken` handshake when the subscription is created. Lifecycle notifications use the same URL with `?lifecycle=1`. |

## 2. Entra app registration (once)

1. Entra admin centre → App registrations → **New registration**. Name it e.g. *CRM helpdesk*, single tenant, no redirect URI.
2. Note the **Application (client) id** and **Directory (tenant) id**.
3. **API permissions** → Add → Microsoft Graph → **Application permissions** → `Mail.ReadWrite`, `Mail.Send` → **Grant admin consent**.
4. **Certificates & secrets**: either
   - upload a certificate (recommended). Create one with `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 730 -nodes -subj "/CN=crm-helpdesk"`; upload `cert.pem`; keep `key.pem` for the CRM; or
   - create a client secret and copy its **value** (shown once).
5. Record the expiry date; the CRM shows a warning 30 days before it.

## 3. Restrict the app to the support mailbox (Exchange Online PowerShell)

```powershell
Connect-ExchangeOnline
# A mail-enabled security group containing only the support mailbox
New-DistributionGroup -Name "CRM helpdesk mailboxes" -Type Security -Members support@yourcompany.co.uk
New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId "CRM helpdesk mailboxes" -AccessRight RestrictAccess -Description "CRM helpdesk may only touch the support mailbox"
# Verify: Granted for the support mailbox, Denied for anyone else
Test-ApplicationAccessPolicy -AppId <client id> -Identity support@yourcompany.co.uk
Test-ApplicationAccessPolicy -AppId <client id> -Identity someone.else@yourcompany.co.uk
```

Policies take up to 30 minutes to apply. For a **shared mailbox**, nothing else is needed: app-only access does not use delegated "send as" rights, so the mailbox needs no licence beyond what shared mailboxes already have (Sent Items are written by Graph).

## 4. Connect in the CRM

Settings → Helpdesk → **Support mailbox**:

1. Mailbox address, display name, tenant id, client id, credential (secret value, or private key + certificate PEM), optional credential expiry, and the **import cutoff** (mail received before it is never turned into tickets; default: from now).
2. **Verify and connect**: the CRM obtains a token and reads one message from the inbox before storing anything (encrypted with `APP_ENCRYPTION_KEY`). It then creates the change-notification subscription.
3. **Send test**: a controlled test message to one of the CRM's own users. Watch it appear as *accepted* in the outbox; that is the first confirmation that `Mail.Send` works.
4. **Behaviour**: monitored folders (only these create tickets; a mailbox rule that moves mail elsewhere hides it from the helpdesk), acknowledgement template and on/off, unknown-sender policy (create with an unverified requester, or hold in the review queue), closed-ticket reply policy (reopen within N days, otherwise a linked follow-up), signature.

## 5. How mail flows

**Inbound**: Graph posts a notification → the webhook checks the `clientState` for that subscription and writes a row to `mailbox_inbound_queue` (unique per mailbox + message id, so replays collapse) → the worker (`m365.tick`, every minute) claims rows with `SKIP LOCKED`, fetches the message with headers, and decides:

1. sent by the CRM itself → skipped;
2. bounce → tied to the outbox row by the original Message-ID, the reply marked *bounced*, the ticket flagged for review;
3. reply headers (`In-Reply-To` / `References`) match a message on a ticket in this mailbox **and** the sender is a participant or staff → appended (a human reply reopens a resolved ticket; closed tickets follow the policy);
4. otherwise a conversation id or a `[IT-000123]` reference matches, and the sender is a participant → appended;
5. a match exists but the sender is **not** a participant → a new ticket flagged *review*, linked to the candidate, no acknowledgement, no content disclosed;
6. automated mail with no ticket → review, no acknowledgement;
7. anything else → a new ticket; the sender is matched to a contact by address (never a company by domain alone); one acknowledgement is queued with `X-Auto-Response-Suppress: All`.

Attachments are checked against the extension and size policy, stored under `DATA_DIR/attachments`, hashed, and scanned when `CLAMAV_HOST` is set; blocked or failed ones keep a row so the message is never dropped. HTML bodies are sanitised (scripts, styles, forms, event handlers and `javascript:` removed; remote images blocked) and rendered in a sandboxed iframe.

**Recovery**: `m365.delta` (every 5 minutes) walks the delta query per folder from the stored delta link; an expired link (410) restarts from the last successful sync minus a day. `m365.subscriptions` (every 30 minutes) renews the subscription a day before expiry and recreates it if Graph dropped it; lifecycle notifications trigger the same.

**Outbound**: a reply writes the message and an outbox row in one transaction (idempotency key per send, so a double click reuses the row), then the worker creates a draft (`createReply` on the original message keeps threading headers), attaches files, records the draft's immutable id, and calls `send`. States are honest: *queued* → *submitting* → *accepted by Microsoft 365* (delivery to the recipient is never confirmed) or *failed* (retries with backoff, then flagged on the ticket) or *unknown* (the send call timed out after a draft id was recorded: the next attempt checks whether the message left Drafts before doing anything, so nothing is sent twice).

## 6. Deployment

- `docker-compose.yml` mounts the `appdata` volume at `/app/data` on `web` and `worker`; attachments live there. Back it up with the database (`deploy/backup.sh` covers the database; add `docker run --rm -v crm_appdata:/data -v $PWD/backups:/b alpine tar czf /b/appdata.tgz /data` to your backup routine).
- Environment: `DATA_DIR` (default `./data` → `/app/data` in the container), `HELPDESK_MAX_ATTACHMENT_MB`, `HELPDESK_BLOCKED_EXTENSIONS`, optional `CLAMAV_HOST`/`CLAMAV_PORT` (run `clamav/clamav` as another compose service and point at it), `APP_URL` (used for the webhook URL; must be the public HTTPS address).
- The worker must be running (`worker` service). The Integrations page shows its heartbeat; the mailbox page shows *inbound sync is stale* when nothing synced for 20 minutes.
- Feature flag: the Helpdesk section only appears for roles with `helpdesk.read`; leave the mailbox unconnected to run tickets without e-mail. To roll back the e-mail stage, disconnect the mailbox (subscription removed, credentials deleted) and redeploy the previous image; migrations are additive, so the schema can stay.

## 7. Monitoring and recovery

- Mailbox page banners: last error, subscription problems, credential expiry, stale sync. Stat tiles: inbound queued/failed, outbox queued/unknown/failed, accepted in 24 h.
- **Inbound queue** table: *Replay* re-runs a dead or skipped row from scratch (safe: duplicates are detected by provider id and Message-ID).
- **Outbox** table: *Retry* a failed or unknown row (unknown rows reconcile first), *Cancel* one that must not go out.
- **Sync now** runs the delta query; **Process queues** drains both queues on demand; **Renew subscription** recreates the Graph subscription.
- Sync runs and errors also appear under Integrations → sync history (provider *Microsoft 365 mailbox*).
- Retention: inbound queue rows and outbox rows older than 90 days are pruned by the nightly retention job in stage 4; messages and attachments follow the ticket retention policy.

## 8. What is verified and what is not

Everything above is exercised by simulated tests against an in-memory Graph double (`src/connectors/m365/demo.ts`): threading, deduplication, replayed notifications, unauthorised references, attachments, internal-note isolation, delta recovery, subscription renewal, permission revocation, throttling, ambiguous send timeouts, bounces and auto-reply loops. **Live Microsoft 365 behaviour has not been verified from this environment**: connect a test mailbox, run *Send test*, send yourself a mail, and watch the queue tables. The live client parses Graph responses defensively; any shape difference shows up as an inbound queue error with the message id, which *Replay* re-runs after a fix.
