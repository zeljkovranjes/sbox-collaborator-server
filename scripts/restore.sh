#!/bin/sh
# Restore a backup made by backup.sh:  ./scripts/restore.sh backups/collab_2026-09-26_0315.dump
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <dump file>"; exit 1; }
cd "$(dirname "$0")/.."
docker compose stop server
docker compose exec -T db pg_restore -U collab -d collab --clean --if-exists < "$1"
docker compose start server
echo "restored $1"
