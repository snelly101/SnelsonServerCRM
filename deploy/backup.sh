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
# Uploaded files (company photos and documents, helpdesk attachments) live on
# the appdata volume, not in the database: archive them alongside the dump.
FILES=""
if [ -d /appdata/attachments ]; then
  FILES="/backups/crm-files-${STAMP}.tar.gz"
  tar -C /appdata -czf "$FILES" attachments
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o "$FILES.gpg" "$FILES" && rm "$FILES"
    FILES="$FILES.gpg"
  fi
fi
find /backups -name 'crm-*' -mtime +30 -delete
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  aws s3 cp "$OUT" "s3://${BACKUP_S3_BUCKET}/$(basename "$OUT")"
  [ -n "$FILES" ] && aws s3 cp "$FILES" "s3://${BACKUP_S3_BUCKET}/$(basename "$FILES")"
fi
echo "backup written: $OUT${FILES:+ and $FILES}"
