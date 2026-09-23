# Secure Vault — architecture and implementation plan

Status: **proposed, awaiting decisions** (see the last section). No code has been written for this feature.

## 1. What exists today (review of the codebase)

| Area | Finding | Consequence for the vault |
|---|---|---|
| Authentication | Better Auth 1.7, email + password (optional Microsoft SSO), session cookie, role re-read from the DB on every request (`src/lib/session.ts`). Sign-in rate-limited per IP. | Reuse as-is. Add a **step-up re-authentication** check for reveal/copy (see §4). |
| Roles / permissions | Six fixed roles; a static action matrix in `src/lib/permissions.ts` (`can`, `assertCan`, `requireActionPermission`). Enforced in every server action and route handler; the UI only hides controls. | The brief needs *independent* per-user capabilities (see exists / view usernames / reveal / copy / create / edit / delete / audit). The role matrix cannot express that, so the vault adds **per-user vault grants** layered on top (§5). |
| Database | PostgreSQL 16, Drizzle ORM, SQL migrations in `drizzle/`, `pgcrypto`/`pg_trgm` enabled, uuid PKs, `timestamps` helper, jsonb for flexible fields, enum types. | New tables follow the same conventions; migration `0006_vault.sql`. |
| Customer model | `companies` → `sites`, `contacts`; custom fields via `custom_field_defs` + jsonb; tags via join table; activity timeline per company. | Vault items hang off `companies` (optionally a `site`). Custom secure fields are stored *inside the encrypted blob*, not in the jsonb custom-field mechanism, so they are never plaintext. |
| Backend | Next.js App Router server actions wrapped in `runAction` → `ActionResult`; zod validation; route handlers only for auth, webhooks, exports, health. | Vault reads/writes are server actions. **Reveal** is a dedicated action that returns the plaintext only after permission + step-up checks; the page never receives secrets in its props. |
| Audit | `audit_log` table (actor, action, entity, jsonb details, ip). `scrubDetails` redacts keys that look like secrets. **Rows are ordinary inserts; nothing stops an admin with DB access from editing or deleting them.** No `ipAddress` is captured by most callers. | The vault gets its own **append-only** audit table with a hash chain (§7) and captures IP + user agent; the general audit log also gets a row for cross-referencing. |
| Secrets / keys | `src/lib/crypto.ts`: AES-256-GCM, one key `APP_ENCRYPTION_KEY` from the environment, format `v1‖iv‖tag‖ct`. Used for integration credentials. No key versioning, no rotation, no separate key for customer data. | Introduce envelope encryption with a **separate vault master key**, per-item data keys, key ids in the ciphertext header, and rotation support (§3). |
| Logging | pino with path-based redaction (`*.password`, tokens, cookies). Next.js error overlays are off in production; server errors log the message only. | Extend redaction paths (`*.secret`, `*.plaintext`, `*.totp*`, `*.privateKey`, `*.recoveryCodes`). Vault code never puts a secret in an Error message or a log object (§9). |
| Frontend | Tailwind 4 design tokens, Radix primitives (`Dialog`, `Tabs`), shared `Card`, `Badge`, `Button`, `FilterBar`, forms with `useActionState`. No client-side state persistence beyond saved views. | New tab on the company page, new components in the same style. No `localStorage` for anything vault-related. |
| Backups | Nightly `pg_dump` gzipped and gpg-encrypted with `BACKUP_PASSPHRASE`; optional S3 upload. | Ciphertext is inside the dump; without the vault master key it is unreadable. The master key must be backed up separately (§10). |

## 2. Data model

New tables (all uuid PKs, `timestamps`):

```
vault_categories        id, name (unique, ci), icon, sort_order, is_system, archived_at
vault_items             id, company_id (fk cascade), site_id (fk set null), category_id (fk restrict),
                        name, username, url, reference,          -- non-secret metadata, searchable
                        tags text[], is_favourite, review_at (date), expires_at (date),
                        key_id (fk vault_keys), wrapped_dek bytea, ciphertext bytea, cipher_version smallint,
                        secret_kinds text[],                     -- which secret fields exist, e.g. {password,totp,api_key}
                        created_by, updated_by, last_revealed_at, reveal_count int,
                        archived_at
vault_keys              id, kind ('master'), key_version int, created_at, retired_at,
                        -- holds NO key material; records which master key version wrapped each DEK
vault_grants            id, user_id (fk), scope ('all' | 'company'), company_id (nullable fk),
                        can_list, can_view_username, can_reveal, can_copy, can_create, can_edit, can_delete, can_audit,
                        granted_by, granted_at, expires_at, revoked_at
vault_audit             id bigserial, at, actor_user_id, company_id, item_id, action,
                        ip_address, user_agent, session_id, details jsonb (never secrets),
                        prev_hash bytea, hash bytea               -- hash chain (§7)
vault_settings          (rows in app_settings): reveal_timeout_seconds (default 30),
                        clipboard_clear_seconds (default 20), step_up_max_age_minutes (default 10),
                        review_reminder_days (default 14)
```

**The encrypted blob** (`ciphertext`) is a JSON document, so new secret types are additive with no schema change:

```json
{ "v": 1,
  "password": "…", "notes": "…",
  "totp": { "secret": "BASE32…", "issuer": "…", "digits": 6, "period": 30 },
  "recovery_codes": ["…"],
  "api_key": "…",
  "ssh": { "private_key": "-----BEGIN…", "passphrase": "…" },
  "custom": [ { "label": "PIN", "value": "1234", "secret": true } ] }
```

Everything that must be searchable stays outside the blob (name, username, URL, reference, category, tags). Username is metadata, not a secret, but is gated by `can_view_username` at render time.

## 3. Encryption strategy and key management

**Envelope encryption, AES-256-GCM throughout, Node's `crypto` only (no custom primitives).**

1. Each item gets its own random 256-bit data-encryption key (DEK). The blob is encrypted with the DEK: `nonce(12) ‖ tag(16) ‖ ct`, with **AAD = item id ‖ company id ‖ cipher_version** so a ciphertext copied onto another row fails to decrypt.
2. The DEK is wrapped (AES-256-GCM again) with the **vault master key** (KEK) and stored as `wrapped_dek` alongside `key_id` (which KEK version wrapped it).
3. The KEK is `VAULT_MASTER_KEY` in the environment, **distinct from `APP_ENCRYPTION_KEY`**. Compromise of the database gives ciphertext and wrapped DEKs only. Compromise of `APP_ENCRYPTION_KEY` (integration credentials) does not reach the vault.
4. **Rotation**: a new `VAULT_MASTER_KEY_NEXT` is added, a job re-wraps every DEK (cheap, no blob decryption needed), `vault_keys` records the new version, then the old variable is removed. Item DEKs are rotated on edit (new DEK each save) and on demand.
5. **Reveal path**: server action → permission + step-up checks → unwrap DEK → decrypt blob → return only the requested field → DEK and plaintext zeroed (`Buffer.fill(0)`) after use. Plaintext never touches the DB, cache, logs or page props.
6. **KEK loading**: read once at startup into a `Buffer`, never into a string; the worker container gets the key only if a background job needs it (expiry reminders do not, so by default **the worker does not receive `VAULT_MASTER_KEY` at all**).

Option for later (not in v1): store the KEK in an external KMS (AWS KMS / Azure Key Vault / HashiCorp Vault transit) so it never sits on the VPS. The `vault_keys` table and wrapped-DEK design make that a drop-in change.

## 4. Authentication for sensitive actions (step-up)

Reveal and copy require the user to have **re-entered their password within the last N minutes** (default 10, admin-configurable). Implemented as a server-side timestamp on the session (`vault_step_up_at`), set by a dedicated "Confirm your password" dialog that calls Better Auth's password verification. SSO-only users confirm via a fresh SSO round-trip. This stops an unlocked, unattended browser from being a credential leak.

## 5. Permission enforcement

- New actions in `permissions.ts`: `vault.admin` (manage categories, grants, settings, view all audit) granted to **admin only**; `vault.use` (may hold grants) granted to admin, technician, account_manager. Sales, finance and read_only cannot be granted vault access at all; the UI tab is not rendered for them and the actions refuse.
- **Per-user grants** (`vault_grants`) carry the eight independent capabilities from the brief. A grant is either **all companies** or **one company** (so a contractor can be given one customer). Admins get an implicit all-companies grant with every capability; everything else is explicit.
- Every vault server action calls `requireVaultCapability(companyId, "reveal")`, which resolves role → `vault.use` → grants → capability, and refuses otherwise. `can_reveal` implies `can_view_username` and `can_list`; `can_copy` requires `can_reveal`.
- **The backend never sends a secret to a user who lacks `can_reveal`**: the list action returns metadata only; the reveal action is the only path to plaintext and is capability-gated per call.
- Grants UI under Settings → Vault access (admins): table of users × capabilities, scope, expiry; every change audited as `vault.grant.changed`.

## 6. Backend / API design (server actions, same pattern as the rest of the CRM)

| Action | Capability | Notes |
|---|---|---|
| `listVaultItems(companyId, filters)` | list | metadata only; username omitted unless `view_username` |
| `getVaultItem(id)` | list | metadata + which secret kinds exist |
| `revealVaultSecret(id, field)` | reveal (+ step-up) | returns one field's plaintext; audited with the field name |
| `copyVaultSecret(id, field)` | copy (+ step-up) | same as reveal but audited as `copied`; UI puts it on the clipboard without displaying it |
| `createVaultItem`, `updateVaultItem` | create / edit | secrets arrive in the action payload over TLS, are encrypted immediately, never logged |
| `deleteVaultItem(id)` | delete | soft delete (`archived_at`); hard purge is an admin job after 30 days |
| `generatePassword(policy)` | create or edit | server-side CSPRNG; the generated value is returned once and not stored until saved |
| `totpCode(id)` | reveal | computes the current 6-digit code server-side so the TOTP seed itself need not be revealed |
| `listVaultAudit(filters)` | audit | per item, per company, per user, date range; admins see all |
| categories / grants / settings actions | vault.admin | |

Rate limits: reveal/copy limited per user (e.g. 60 per 10 minutes) with an audit row and admin notification on breach. Bulk export of secrets does not exist by design.

## 7. Audit architecture

- `vault_audit` is **append-only**: the app role gets `INSERT` and `SELECT` only (no `UPDATE`/`DELETE`, enforced with a Postgres trigger that raises on either). Retention job never touches it.
- **Hash chain**: each row stores `hash = SHA-256(prev_hash ‖ canonical JSON of the row)`. A nightly job (and an admin button) re-walks the chain and reports the first broken link, so tampering by anyone with DB access is detectable.
- Events: `created`, `viewed` (metadata opened), `revealed` (field), `copied` (field), `totp_code_generated`, `modified` (field names only, never values), `deleted`, `restored`, `grant_changed`, `category_changed`, `settings_changed`, `step_up_succeeded/failed`, `rate_limited`.
- Each row: actor, company, item, action, timestamp, IP (from `x-forwarded-for` set by Caddy), user agent, session id, details (field name, old/new *metadata* only).
- A row is also written to the general `audit_log` (with `entityType: "vault_item"`) so the existing Settings → Audit page shows vault activity in context.
- UI: **History** on each item; **Vault audit** page for admins with filters ("who revealed Acme's firewall password in March?"), and a per-customer audit tab.

## 8. Frontend

- Company page gains a **Secure Vault** tab (rendered only when the user can list). Layout: search box + category/tag filters (client-side over metadata), favourites first, then a table/card list: category icon, name, username (masked "••••" unless `view_username`), URL (link), review/expiry badge, actions: Reveal, Copy, TOTP, Edit, History.
- **Reveal**: opens the step-up dialog if needed, then shows the secret in a monospace field with a countdown; hides automatically after `reveal_timeout_seconds`; re-masks on tab blur.
- **Copy**: never renders the value; writes to the clipboard via the async Clipboard API and overwrites it with an empty string after `clipboard_clear_seconds` (best-effort: browsers only allow clearing while the tab is focused, and this is stated in the UI).
- **Edit/create** form: name, category, username, URL, reference, tags, review date, expiry date, then a "Secrets" section with password (+ generator, strength meter), secure notes, and an "Add secret field" menu (TOTP, recovery codes, API key, SSH key, custom). Secret inputs are `type=password` with a show toggle, `autocomplete="off"`, and are cleared on unmount.
- No vault data is ever placed in `localStorage`, `sessionStorage`, URL parameters or saved views. Pages set `Cache-Control: no-store`.
- Reminders: the existing daily reminder job creates a task "Review credential: Acme firewall" `review_reminder_days` before `review_at`/`expires_at` (metadata only, no secrets).

## 9. Preventing leakage

- pino redaction extended; vault module logs only ids and action names.
- Errors thrown by vault code carry fixed messages ("Could not decrypt item"), never input.
- `scrubDetails` extended to reject any details object containing keys `secret|password|totp|recovery|private_key|value` before insert.
- Server actions return `ActionResult` objects; a thrown error is caught by `runAction` and its message is generic for vault actions.
- Next.js `serverActions` bodies are not logged by the app; Caddy access logs record paths only (already the case).
- Playwright/e2e tests use synthetic secrets and assert that page HTML never contains them.
- CSV export, global search and the search API skip vault tables entirely.

## 10. Backup and restore

- Database dumps contain ciphertext and wrapped DEKs only. **Restoring requires the same `VAULT_MASTER_KEY`.** Deployment docs get a "Vault key custody" section: store it in the password manager alongside `APP_ENCRYPTION_KEY`, ideally split (two halves with two people) for a business that will hold thousands of customer secrets.
- Restore drill extended: decrypt one vault item after a test restore to prove the key is intact.
- A "vault health" row on `/api/health`: KEK present, key version matches `vault_keys`, chain verified at last check (booleans only).

## 11. Migration and rollout

1. Migration `0006_vault.sql`: tables, enums, the append-only trigger on `vault_audit`, seed system categories.
2. `.env.example` and compose: `VAULT_MASTER_KEY` for `web` only; `docker compose` refuses to start `web` without it once the feature is enabled (`VAULT_ENABLED=true`).
3. Permissions and grants; admins get the tab immediately, nobody else until granted.
4. UI, actions, audit page, reminders, tests, docs.
5. Optional later: KMS-backed KEK, browser-side additional encryption ("vault passphrase" per user), IP allow-lists for reveal.

## 12. Security risks and mitigations

| Risk | Mitigation |
|---|---|
| Database dump stolen | Envelope encryption with a KEK that is not in the database. |
| Server compromise (attacker reads env) | KEK is in memory on `web` only; step-up + rate limits + audit chain limit and expose bulk extraction; KMS option removes the KEK from the box entirely. |
| Insider with a valid login | Capability grants, step-up re-auth, per-reveal audit with IP, admin alerts on rate-limit breach, immutable chain. |
| Unattended unlocked browser | Step-up window, auto-hide, clipboard clear, re-mask on blur. |
| Secrets in logs / errors / telemetry | Redaction paths, generic error messages, scrubbed audit details, no analytics in the app. |
| Secret leaks through search or exports | Vault tables excluded from search, export and CSV; metadata only is searchable. |
| Audit tampering | Append-only role + trigger + hash chain + nightly verification. |
| Key loss | Documented custody, restore drill, health check. |
| Cross-item ciphertext swapping | AAD binds ciphertext to item and company ids. |

## 13. Decisions needed before coding

1. **Reverse the original brief's exclusion** of customer credentials: confirm you accept the residual risk described above and will follow the key-custody procedure.
2. **Key custody**: environment variable on the VPS (simplest, v1) or an external KMS from day one (more setup, key never on the box). Recommendation: env var now, KMS later; the design supports both.
3. **Step-up re-authentication window**: 10 minutes by default? And should SSO users be forced to re-authenticate via Microsoft, or may they set a CRM password for step-up?
4. **Who may hold grants**: proposal is admin, technician and account manager. Should sales or finance ever see the vault (even list-only)?
5. **Reveal limits**: 60 reveals per user per 10 minutes with admin alert. Too tight or too loose for your team?
6. **Retention of deleted items**: soft delete then hard purge after 30 days, or keep indefinitely as archived?
7. **TOTP**: store seeds and generate codes in the CRM (convenient, but the CRM becomes a second factor for customer systems), or leave TOTP out of v1?
8. **SSH private keys**: include in v1, or later?
9. **Scope**: v1 = items, categories, grants, reveal/copy/step-up, audit page + history, generator, review reminders. Defer TOTP, SSH, favourites, tags? Or all in one go (roughly twice the effort)?
