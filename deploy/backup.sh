#!/usr/bin/env bash
# Off-site backup for a Tripcord deploy: pg_dump, then restic to any restic
# repository (S3-compatible storage such as Backblaze B2, SFTP, ...).
# Run it from cron next to docker-compose.yml. See docs/self-hosting.md → Off-site backups.
set -euo pipefail

cd "$(dirname "$0")"
if [ -f backup.env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./backup.env
  set +a
fi
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY in backup.env}"
: "${RESTIC_PASSWORD:?Set RESTIC_PASSWORD in backup.env}"
KEEP_DAILY="${KEEP_DAILY:-14}"

dump="$(mktemp)"
trap 'rm -f "$dump"' EXIT

# Dump to a file first, so a failed pg_dump can't become a truncated snapshot.
docker compose exec -T postgres pg_dump -U tripcord -Fc tripcord > "$dump"
restic backup --quiet --tag tripcord --stdin --stdin-filename tripcord.dump < "$dump"
restic forget --quiet --tag tripcord --keep-daily "$KEEP_DAILY" --prune

if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$BACKUP_HEARTBEAT_URL" > /dev/null
fi
