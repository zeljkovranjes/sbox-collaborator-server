#!/bin/sh
# Nightly PostgreSQL backup. Cron example (keeps 14 days):
#   15 3 * * * cd /opt/collaborator && ./scripts/backup.sh >> backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date +%Y-%m-%d_%H%M)
docker compose exec -T db pg_dump -U collab -d collab --format=custom > "backups/collab_$stamp.dump"
find backups -name 'collab_*.dump' -mtime +14 -delete
echo "backup ok: backups/collab_$stamp.dump"
