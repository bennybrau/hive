#!/usr/bin/env bash
# Bring the Hive up on this host and mint the first (curator) token.
#   scripts/setup.sh [--curator-user jon] [--curator-name <instance-name>]
# Safe to re-run: keeps an existing .env and never re-mints a curator that exists.
set -euo pipefail
cd "$(dirname "$0")/.."

CURATOR_USER="${USER:-curator}"
CURATOR_NAME="$(hostname -s)-curator"
while [ $# -gt 0 ]; do
  case "$1" in
    --curator-user) CURATOR_USER="$2"; shift 2 ;;
    --curator-name) CURATOR_NAME="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

# --- plan: every check before any change -------------------------------------
command -v docker >/dev/null || { echo "docker not found on PATH" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon not reachable - start Docker Desktop / Rancher and retry" >&2; exit 1; }

VOLUME_EXISTS=0
docker volume inspect hive_pgdata >/dev/null 2>&1 && VOLUME_EXISTS=1
if [ ! -f .env ] && [ "$VOLUME_EXISTS" = 1 ]; then
  echo "refusing: volume hive_pgdata exists but .env is missing." >&2
  echo "A new POSTGRES_PASSWORD would not match the existing database. Restore .env, or remove the volume" >&2
  echo "deliberately (docker volume rm hive_pgdata - destroys all hive data)." >&2
  exit 1
fi

# --- act ----------------------------------------------------------------------
if [ ! -f .env ]; then
  PW="$(openssl rand -hex 24)"
  sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${PW}/" .env.example > .env
  chmod 600 .env
  echo "wrote .env (new POSTGRES_PASSWORD)"
else
  echo "keeping existing .env"
fi
if ! grep -qE '^HIVE_SECRET_KEY=.+' .env; then
  KEY="$(openssl rand -hex 32)"
  if grep -q '^HIVE_SECRET_KEY=' .env; then
    sed -i.bak "s/^HIVE_SECRET_KEY=.*/HIVE_SECRET_KEY=${KEY}/" .env && rm -f .env.bak
  else
    printf '\nHIVE_SECRET_KEY=%s\n' "$KEY" >> .env
  fi
  echo "added HIVE_SECRET_KEY to .env"
fi
set -a; . ./.env; set +a

echo "building and starting the stack..."
docker compose up -d --build --wait

HEALTH="$(curl -fsS "http://127.0.0.1:${HIVE_PORT:-8800}/health")"
echo "health: ${HEALTH}"

EXISTING="$(docker compose exec -T postgres psql -U hive -d hive -tAc "select count(*) from instances where role='curator' and revoked_at is null")"
if [ "${EXISTING// /}" != "0" ]; then
  echo "a curator token already exists; not minting another. Mint member tokens with:"
  echo "  docker compose exec hive node dist/cli/mint-token.js --name <instance> --user <user>"
  exit 0
fi

OUT="$(docker compose exec -T hive node dist/cli/mint-token.js --name "$CURATOR_NAME" --user "$CURATOR_USER" --role curator)"
TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/^HIVE_TOKEN=//p')"
HOST_URL="http://$( [ "${HIVE_BIND:-127.0.0.1}" = "0.0.0.0" ] && hostname -s || echo 127.0.0.1 ):${HIVE_PORT:-8800}"

cat <<EOF

Hive is up.
  curator instance: ${CURATOR_NAME} (user ${CURATOR_USER})

Put these in the Hermes .env of the machine that will use this token (shown once, only its hash is stored):
  HIVE_URL=${HOST_URL}
  HIVE_TOKEN=${TOKEN}

Then install the plugin (see plugins/hive/README.md).
EOF
