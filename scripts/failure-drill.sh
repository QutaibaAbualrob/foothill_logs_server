#!/usr/bin/env bash
# Failure drill — the G2 rows that need container orchestration.
#
# Asserts that losing PostgreSQL degrades the service instead of killing it:
# every endpoint answers 503 with Retry-After, the application container does
# not restart, and traffic recovers on its own once the database returns.
#
# The container-restart check is the important one. A process that exits and is
# restarted by the orchestrator can look healthy a second later while having
# dropped every queued batch and every in-flight request, so "it came back" is
# not the same as "it stayed up".
#
# Usage: HOST_PORT=8081 ./scripts/failure-drill.sh
set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:${HOST_PORT:-8080}}"
FAILURES=0

note() { printf '  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  ok    %s\n' "$*"; }

status_of() { curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo "000"; }
header_of() { curl -s -D- -o /dev/null "$1" 2>/dev/null | grep -i "^$2:" | tr -d '\r' || true; }

started_at="$(docker inspect -f '{{.State.StartedAt}}' server_loger-api-1 2>/dev/null || echo unknown)"
restarts_before="$(docker inspect -f '{{.RestartCount}}' server_loger-api-1 2>/dev/null || echo unknown)"

echo "== 1. baseline =="
code="$(status_of "$BASE_URL/health")"
[ "$code" = "200" ] && pass "health is 200" || { fail "health is $code before the drill"; exit 1; }

echo "== 2. stop PostgreSQL =="
docker compose stop postgres >/dev/null 2>&1
sleep 4

echo "== 3. every endpoint degrades to 503, never 500 =="
for probe in \
  "/health" \
  "/logs?limit=1" \
  "/logs/aggregate?since=2020-01-01T00:00:00Z&until=2020-01-02T00:00:00Z&bucket=1h"
do
  code="$(status_of "$BASE_URL$probe")"
  case "$code" in
    503) pass "GET $probe -> 503" ;;
    000) fail "GET $probe -> no response (process is down)" ;;
    5*)  fail "GET $probe -> $code (a 5xx that is not 503)" ;;
    *)   fail "GET $probe -> $code (expected 503)" ;;
  esac
done

post_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/logs" \
  -H 'content-type: application/json' \
  -d '{"logs":[{"timestamp":"2026-01-01T00:00:00Z","level":"info","service":"drill","message":"during outage"}]}' 2>/dev/null || echo "000")"
[ "$post_code" = "503" ] && pass "POST /logs -> 503" || fail "POST /logs -> $post_code (expected 503)"

retry_after="$(curl -s -D- -o /dev/null "$BASE_URL/logs?limit=1" 2>/dev/null | grep -i '^retry-after:' | tr -d '\r' || true)"
[ -n "$retry_after" ] && pass "Retry-After present ($retry_after)" || fail "Retry-After header missing on 503"

echo "== 4. the application container did not restart =="
started_now="$(docker inspect -f '{{.State.StartedAt}}' server_loger-api-1 2>/dev/null || echo unknown)"
restarts_now="$(docker inspect -f '{{.RestartCount}}' server_loger-api-1 2>/dev/null || echo unknown)"
if [ "$started_now" = "$started_at" ] && [ "$restarts_now" = "$restarts_before" ]; then
  pass "same process throughout (started $started_at, restarts $restarts_now)"
else
  fail "container restarted: start $started_at -> $started_now, restarts $restarts_before -> $restarts_now"
fi

echo "== 5. restart PostgreSQL and confirm self-recovery =="
docker compose start postgres >/dev/null 2>&1
recovered=0
for _ in $(seq 1 30); do
  sleep 2
  if [ "$(status_of "$BASE_URL/health")" = "200" ]; then recovered=1; break; fi
done
[ "$recovered" = "1" ] && pass "health returned to 200" || fail "health did not recover within 60s"

code="$(status_of "$BASE_URL/logs?limit=1")"
[ "$code" = "200" ] && pass "GET /logs -> 200" || fail "GET /logs -> $code after recovery"

post_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/logs" \
  -H 'content-type: application/json' \
  -d '{"logs":[{"timestamp":"2026-01-01T00:00:00Z","level":"info","service":"drill","message":"after recovery"}]}' 2>/dev/null || echo "000")"
[ "$post_code" = "200" ] && pass "POST /logs -> 200" || fail "POST /logs -> $post_code after recovery"

started_final="$(docker inspect -f '{{.State.StartedAt}}' server_loger-api-1 2>/dev/null || echo unknown)"
[ "$started_final" = "$started_at" ] \
  && pass "survived the whole drill without a restart" \
  || fail "container restarted during recovery"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "failure drill: PASS"
else
  echo "failure drill: FAIL ($FAILURES checks)"
  exit 1
fi
