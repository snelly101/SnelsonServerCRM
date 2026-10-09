# Deployment

Target: a single **Debian 12** VPS (2 vCPU / 4 GB RAM / 80 GB SSD recommended, e.g. 20i unmanaged VPS, UK data centre) running Docker Compose. A shared-hosting variant is at the end.

## 1. Server preparation (once)

Log in as root on the fresh VPS and run the hardening script:

```bash
apt-get install -y git
git clone https://github.com/snelly101/SnelsonServerCRM.git /opt/crm-src
bash /opt/crm-src/deploy/server-setup.sh deploy "ssh-ed25519 AAAA... you@laptop"
```

It installs Docker, creates a `deploy` user (key-only SSH, root login off), enables `ufw` (22/80/443 only), `fail2ban` and unattended security upgrades.

## 2. DNS

Create an `A` record, e.g. `crm.snelsonserver.com → <VPS IP>`. Caddy obtains the Let's Encrypt certificate automatically once DNS resolves.

## 3. Configure and start

As the `deploy` user:

```bash
git clone https://github.com/snelly101/SnelsonServerCRM.git ~/crm && cd ~/crm
cp .env.example .env
```

Edit `.env`:

```
NODE_ENV=production
APP_URL=https://crm.snelsonserver.com
BETTER_AUTH_URL=https://crm.snelsonserver.com
CRM_DOMAIN=crm.snelsonserver.com
POSTGRES_PASSWORD=<openssl rand -base64 24>
APP_ENCRYPTION_KEY=<openssl rand -base64 32>
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BACKUP_PASSPHRASE=<openssl rand -base64 24>      # encrypts nightly dumps
DEMO_MODE=false                                   # must be false in production: enables synthetic integration data
# leave DATABASE_URL blank: compose sets it to the internal db container
```

Then:

```bash
docker compose up -d --build     # builds, runs migrations, starts web + worker + caddy + backup
docker compose logs -f web       # wait for "Ready"
```

Create the first administrator (there is no public sign-up):

```bash
docker compose run --rm worker npx tsx -e '
  import("./src/services/users.ts").then(m => m.createUser({ name: "Ryan", email: "ryan@snelsonserver.com", role: "admin", password: "<strong password>" }, null)).then(() => process.exit(0))'
```

Open `https://crm.snelsonserver.com`, sign in, then go to Settings → General (company name, currency, timezone) and Settings → Users to add staff.

## 4. Updating

```bash
cd ~/crm && git pull && docker compose up -d --build
```

Migrations run automatically in the `migrate` service before `web` and `worker` start. Take a VPS snapshot before major upgrades.

## 5. Backups and restore

- The `backup` container runs `deploy/backup.sh` every 24 h: `pg_dump | gzip`, encrypted with `BACKUP_PASSPHRASE` (AES-256 via gpg), kept 30 days in `~/crm/backups/`.
- **Off-site:** set `BACKUP_S3_BUCKET` and AWS-style credentials in `.env` (Backblaze B2 and Cloudflare R2 are S3-compatible) and the script uploads each dump. Off-site copies are what protect you from a lost VPS. Budget a couple of pounds a month.
- **Restore test (do this once after setup, and quarterly):**

```bash
FILE=backups/crm-YYYYMMDD-HHMMSS.sql.gz.gpg
gpg --batch --passphrase "$BACKUP_PASSPHRASE" -d $FILE | gunzip > /tmp/restore.sql
docker compose exec -T db psql -U crm -c "drop database if exists crm_restore; create database crm_restore;"
docker compose exec -T db psql -U crm -d crm_restore < /tmp/restore.sql
docker compose exec db psql -U crm -d crm_restore -c "select count(*) from companies;"
rm /tmp/restore.sql
```

To restore for real: stop `web` and `worker`, restore into `crm`, start them again.

- **What a backup contains:** all CRM data, encrypted integration tokens (useless without `APP_ENCRYPTION_KEY`) and pg-boss job history. **Keep `.env` backed up separately** (password manager). Without `APP_ENCRYPTION_KEY` the integration credentials in a restored database cannot be decrypted and must be re-entered.

## 5a. Secure Vault key custody

The customer credentials vault (Phase 7) encrypts every secret with a per-item key wrapped by **`VAULT_MASTER_KEY`**, a second 32-byte key that is deliberately separate from `APP_ENCRYPTION_KEY`.

- Generate it once: `openssl rand -base64 32`, put it in `.env` as `VAULT_MASTER_KEY=` with `VAULT_MASTER_KEY_VERSION=1`, then `docker compose up -d web`. Only the `web` container receives it; compose blanks it for the worker.
- **Store the key in your password manager the moment you create it**, ideally in a separate entry from the other secrets, and give a second person access. A database backup without this key holds only ciphertext: if the key is lost every stored credential is unrecoverable and there is no reset.
- **Rotation** (yearly, or immediately after any suspected exposure): generate a new key, set it as `VAULT_MASTER_KEY` with `VAULT_MASTER_KEY_VERSION=2`, move the old one to `VAULT_MASTER_KEY_PREVIOUS` / `VAULT_MASTER_KEY_PREVIOUS_VERSION=1`, restart `web`, then Settings → Secure Vault → **Re-wrap with current key**. When it reports 0 items left on the old version, remove the `_PREVIOUS` variables and restart.
- **Restore drill** (add to the quarterly test in section 5): after restoring into `crm_restore`, open one vault item in the CRM pointed at that database, or run the unit suite's crypto test with the production key, to prove the key still decrypts.
- The vault audit trail is append-only at the database level and hash-chained; the nightly job re-verifies it and `/api/health` reports `vault.chainOk`. A `false` there means someone with database access altered history: treat as an incident.

### Offline plain-text backup of the vault

A database dump is useless without the master key, so keep a periodic **plain-text copy** of the vault offline as the last line of defence against a lost key or corrupted database.

- **Who and when:** an administrator, quarterly (do it right after the restore drill above) and before any key rotation or migration. Settings → Secure Vault → **Offline backup** → *Export backup*.
- **What it asks for:** your CRM password again (within five minutes of the export), a reason, the typed phrase `EXPORT ALL SECRETS`, and either a passphrase of 12+ characters (recommended) or a tick confirming you accept a clear-text download. Two exports per hour are allowed across all administrators.
- **What you get:** `vault-backup-<timestamp>.zip` (or `.zip.enc` when passphrase-protected) containing `vault-backup.csv`, `vault-backup.json` and `README.txt`. The CSV has one row per item with company, category, name, username, password, URL, TOTP seed and `otpauth://` URI, API key, recovery codes, notes, custom fields, tags, review and expiry dates and archive state. The JSON is the same data with structure; it is the file the CRM imports.
- **Decrypting a protected file:** `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in vault-backup-<timestamp>.zip.enc -out vault-backup.zip`, then unzip. Store the passphrase separately from the file (it is not kept anywhere in the CRM).
- **Where to keep it:** as an attachment in the password manager entry that holds `VAULT_MASTER_KEY`, or printed/USB in a sealed envelope in the safe. Never email, chat, shared drive or ticket. Delete the copy in Downloads, and destroy superseded copies when a new backup is taken.
- **What is recorded:** an `exported` row in the vault audit chain with your name, IP address, reason, item count and the SHA-256 of the plain ZIP (the dialog shows the hash so you can label the copy), plus an urgent task for every other administrator asking them to confirm the export was expected. An export nobody can explain is an incident.
- **Restoring:** generate a fresh `VAULT_MASTER_KEY` if the old one is lost (set `VAULT_MASTER_KEY_VERSION` to the next number), restart `web`, then Settings → Secure Vault → **Import backup** with `vault-backup.json`, your password, a reason and the phrase `IMPORT BACKUP`. Items whose id already exists are skipped, so importing over a partly intact vault is safe; customers and categories missing from the database are created by name. The import is audited (`imported`, with counts and the file hash) and raises the same administrator task.

## 6. Monitoring

- **`GET https://crm.example.com/api/health`** returns `200 {"status":"ok","database":"ok","worker":"alive",...}` when the database answers, the worker heartbeat is under 15 minutes old and the helpdesk block reports no problems (mailbox subscription, stale inbound sync, dead inbound or unknown/failed outbox rows, SLA job overdue), otherwise `503 {"status":"degraded",...}` with the reasons under `helpdesk.problems`. Point an uptime monitor (UptimeRobot, Better Stack, Healthchecks.io, all have free tiers) at it every 5 minutes; that one check covers the web app, the database and the worker.
- `docker compose ps` — all services `running`; `migrate` is expected to show `exited (0)`.
- `docker compose logs --since 1h worker` — job failures are logged as JSON with `level: 50`.
- The Integrations page shows *worker alive / stale / never* with the last heartbeat, last successful sync per provider, paused connectors and unresolved conflicts. Reports → Integration health adds failed/partial runs in the last 24 hours.
- Disk: `df -h` monthly; backups are pruned after 30 days locally but the database volume grows with mirrored invoices and devices (expect well under 1 GB for a small MSP).

## 6a. Go-live checklist

1. `.env` secrets generated and stored in the password manager: `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `BACKUP_PASSPHRASE`; `DEMO_MODE=false`; `APP_URL`/`BETTER_AUTH_URL`/`CRM_DOMAIN` set to the real hostname.
2. `docker compose ps` healthy, `/api/health` returns 200, HTTPS certificate issued (Caddy log).
3. First admin created, then staff users added with the least role they need (Settings → Users). Each person enrols an authenticator app on their Security page; then set the two-factor policy under Settings → Security (roles + grace period). `BETTER_AUTH_SECRET` encrypts the authenticator secrets, so it must be in the password manager with the other keys.
4. Integrations entered in the UI: Better Proposals API token (Premium plan), Xero app connected and organisation chosen, NinjaOne client id/secret (Monitoring scope), 20i general API key, Pax8 API client id/secret. Each shows **connected**, not *Demo*.
5. Helpdesk mailbox connected per `docs/helpdesk-m365.md` (app registration, admin consent, application access policy, test e-mail accepted), `appdata` volume present; a default SLA policy created; `HELPDESK_ANONYMISE_AFTER_DAYS` decided (see `docs/helpdesk-operations.md`).
6. Customer mapping done for Xero, NinjaOne, 20i and Pax8; counting rules reviewed; a first sync run is green on the Integrations page.
6. Backup restore drill completed once (section 5) and off-site bucket configured.
7. Uptime monitor pointed at `/api/health`.

## 7. Shared-hosting variant (no Docker)

Works on cPanel/Plesk hosts that offer Node 20+, cron every minute, and a PostgreSQL database (or an external managed Postgres such as Neon/Supabase EU).

1. Upload the repo, set `.env` with `DATABASE_URL` pointing at Postgres over TLS.
2. `npm ci && npm run build && npm run db:migrate`.
3. Start the app through the host's Node app manager (entry `node_modules/.bin/next start -p $PORT`) or `npm start`.
4. Cron: `* * * * * cd /home/<user>/crm && npm run jobs:tick >> jobs.log 2>&1`. The tick processes queued jobs for ~50 s and exits; jobs are durable in Postgres.
5. Backups: `0 2 * * * pg_dump "$DATABASE_URL" | gzip | gpg --batch --symmetric --passphrase "$BACKUP_PASSPHRASE" -o ~/backups/crm-$(date +\%F).sql.gz.gpg`.

6. Health: `/api/health` reports the worker as *alive* as long as the cron tick runs; if the host's cron is unreliable it will show *stale* and the Integrations page will warn.

Limitations: builds need ~2 GB RAM (build locally or in CI and upload `.next/` if the host is smaller); webhooks require the app to answer within 5 s, so keep the app "always on" if the host offers it.
