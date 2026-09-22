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

## 6. Monitoring

- **`GET https://crm.example.com/api/health`** returns `200 {"status":"ok","database":"ok","worker":"alive",...}` when the database answers and the worker heartbeat is under 15 minutes old, otherwise `503 {"status":"degraded",...}`. Point an uptime monitor (UptimeRobot, Better Stack, Healthchecks.io, all have free tiers) at it every 5 minutes; that one check covers the web app, the database and the worker.
- `docker compose ps` — all services `running`; `migrate` is expected to show `exited (0)`.
- `docker compose logs --since 1h worker` — job failures are logged as JSON with `level: 50`.
- The Integrations page shows *worker alive / stale / never* with the last heartbeat, last successful sync per provider, paused connectors and unresolved conflicts. Reports → Integration health adds failed/partial runs in the last 24 hours.
- Disk: `df -h` monthly; backups are pruned after 30 days locally but the database volume grows with mirrored invoices and devices (expect well under 1 GB for a small MSP).

## 6a. Go-live checklist

1. `.env` secrets generated and stored in the password manager: `POSTGRES_PASSWORD`, `APP_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `BACKUP_PASSPHRASE`; `DEMO_MODE=false`; `APP_URL`/`BETTER_AUTH_URL`/`CRM_DOMAIN` set to the real hostname.
2. `docker compose ps` healthy, `/api/health` returns 200, HTTPS certificate issued (Caddy log).
3. First admin created, then staff users added with the least role they need (Settings → Users).
4. Integrations entered in the UI: Better Proposals API token (Premium plan), Xero app connected and organisation chosen, NinjaOne client id/secret (Monitoring scope). Each shows **connected**, not *Demo*.
5. Customer mapping done for Xero and NinjaOne; counting rules reviewed; a first sync run is green on the Integrations page.
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
