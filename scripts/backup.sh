#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 69
}

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="${project_dir}/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${backup_dir}/switchboard-${timestamp}.db"

mkdir -p "${backup_dir}"
cd "${project_dir}"

restart_app=0
finish() {
  if [[ "${restart_app}" == "1" ]]; then
    docker compose start switchboard >/dev/null
  fi
}
trap finish EXIT

echo "Stopping the SWITCHBOARD app for a consistent SQLite copy..."
docker compose stop switchboard >/dev/null
restart_app=1
docker compose cp "switchboard:/data/switchboard.db" "${destination}" >/dev/null
docker compose start switchboard >/dev/null
restart_app=0
trap - EXIT

echo "Backup created: ${destination}"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${destination}"
fi
