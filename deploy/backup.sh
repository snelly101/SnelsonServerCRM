#!/bin/sh
# Nightly encrypted database dump. Keeps 30 days locally; ships off-site when
# BACKUP_S3_BUCKET is set (see docs/deployment.md).
set -eu
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="/backups/crm-${STAMP}.sql.gz"
pg_dump -h db -U crm -d crm --no-owner --no-privileges | gzip > "$OUT"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  # Symmetric encryption with the passphrase from .env. Restore: gpg -d file.gpg | gunzip | psql
  gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o "$OUT.gpg" "$OUT" && rm "$OUT"
  OUT="$OUT.gpg"
fi
find /backups -name 'crm-*' -mtime +30 -delete
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  aws s3 cp "$OUT" "s3://${BACKUP_S3_BUCKET}/$(basename "$OUT")"
fi
echo "backup written: $OUT"
