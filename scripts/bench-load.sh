#!/usr/bin/env bash
# k6 load scenario runner.
#
# Runs one scenario from the grafana/k6 image on the compose network, so the
# capped application and PostgreSQL containers are the bottleneck rather than
# the harness, and exports the k6 summary JSON to bench/raw/ (gitignored).
#
# Scenarios:
#   load        constant 15,000 logs/s   (LOGS_PER_SECOND, DURATION)
#   stress      15,000 -> 22,500 ramp    (LOGS_PER_SECOND_START/END/STEPS)
#   spike       7,500 -> 30,000 -> 7,500 (same envs)
#   breakpoint  15,000 -> 45,000 ramp    (same envs)
#
# Usage:
#   SCENARIO=load RUN_NAME=baseline-load DURATION=120s npm run bench:load
set -euo pipefail

SCENARIO="${SCENARIO:-load}"
RUN_NAME="${RUN_NAME:-$(date -u +%Y%m%dT%H%M%SZ)-${SCENARIO}}"
DURATION="${DURATION:-120s}"

case "$SCENARIO" in
  load) SCRIPT="ingest-load.js" ;;
  stress|spike|breakpoint) SCRIPT="ingest-load-ramp.js" ;;
  *) echo "unknown SCENARIO: $SCENARIO (expected load, stress, spike, breakpoint)" >&2; exit 1 ;;
esac

NETWORK="server_loger_default"
if ! docker network ls --format '{{.Name}}' | grep -qx "$NETWORK"; then
  echo "compose network '$NETWORK' not found — is the stack running?" >&2
  echo "  HOST_PORT=8081 docker compose up -d --build --wait" >&2
  exit 1
fi

mkdir -p bench/raw
echo "scenario=$SCENARIO script=$SCRIPT run=$RUN_NAME duration=$DURATION"

docker run --rm \
  --network "$NETWORK" \
  -v "$PWD/load:/load" \
  -v "$PWD/bench/raw:/out" \
  -e BASE_URL="${BASE_URL:-http://api:8080}" \
  -e DURATION="$DURATION" \
  -e LOGS_PER_SECOND="${LOGS_PER_SECOND:-}" \
  -e LOGS_PER_SECOND_START="${LOGS_PER_SECOND_START:-}" \
  -e LOGS_PER_SECOND_END="${LOGS_PER_SECOND_END:-}" \
  -e LOGS_PER_SECOND_STEPS="${LOGS_PER_SECOND_STEPS:-}" \
  -e BATCH_SIZE="${BATCH_SIZE:-50}" \
  -e BACKDATE_FRACTION="${BACKDATE_FRACTION:-0.1}" \
  grafana/k6 run --summary-export="/out/${RUN_NAME}.json" "/load/${SCRIPT}"

echo "summary: bench/raw/${RUN_NAME}.json"
