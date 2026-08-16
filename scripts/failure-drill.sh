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

# Probe rows must carry a CURRENT timestamp: a row older than RETENTION_DAYS
# would be swept by the retention pass that fires right after a restart, which
# silently shifts the persisted-row count the SIGTERM section compares.
DRILL_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# git-bash ships a mingw curl that cannot write to MSYS's /dev/null device
# (curl exits 23 and every probe would read as "000"), so probe bodies go to
# a gitignored scratch file instead of the null device.
mkdir -p temp
CURL_BODY="temp/failure-drill-body.out"

note() { printf '  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  ok    %s\n' "$*"; }

status_of() { curl -s -o "$CURL_BODY" -w '%{http_code}' "$1" 2>/dev/null || echo "000"; }
header_of() { curl -s -D- -o "$CURL_BODY" "$1" 2>/dev/null | grep -i "^$2:" | tr -d '\r' || true; }

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

post_code="$(curl -s -o "$CURL_BODY" -w '%{http_code}' -X POST "$BASE_URL/logs" \
  -H 'content-type: application/json' \
  -d "{\"logs\":[{\"timestamp\":\"$DRILL_TS\",\"level\":\"info\",\"service\":\"drill\",\"message\":\"during outage\"}]}" 2>/dev/null || echo "000")"
[ "$post_code" = "503" ] && pass "POST /logs -> 503" || fail "POST /logs -> $post_code (expected 503)"

retry_after="$(curl -s -D- -o "$CURL_BODY" "$BASE_URL/logs?limit=1" 2>/dev/null | grep -i '^retry-after:' | tr -d '\r' || true)"
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

post_code="$(curl -s -o "$CURL_BODY" -w '%{http_code}' -X POST "$BASE_URL/logs" \
  -H 'content-type: application/json' \
  -d "{\"logs\":[{\"timestamp\":\"$DRILL_TS\",\"level\":\"info\",\"service\":\"drill\",\"message\":\"after recovery\"}]}" 2>/dev/null || echo "000")"
[ "$post_code" = "200" ] && pass "POST /logs -> 200" || fail "POST /logs -> $post_code after recovery"

started_final="$(docker inspect -f '{{.State.StartedAt}}' server_loger-api-1 2>/dev/null || echo unknown)"
[ "$started_final" = "$started_at" ] \
  && pass "survived the whole drill without a restart" \
  || fail "container restarted during recovery"

echo "== 6. SIGTERM mid-ingestion: drain in-flight batches, lose no acknowledged row =="
mkdir -p temp

# Both counts are filtered to the retention window. Rows older than
# RETENTION_DAYS are swept by the retention pass that fires on the container
# restart, so an unfiltered COUNT(*) would shift by however many stale rows
# happened to exist — masking or faking the acknowledged-row check.
count_before="$(docker compose exec -T postgres psql -U logger -d logs -tAc "SELECT count(*) FROM logs WHERE timestamp >= now() - interval '30 days';" 2>/dev/null | tr -d '[:space:]')"
count_before="${count_before:-unknown}"
note "rows before SIGTERM: $count_before"

# Keep ingestion running across the signal: 32 workers x 200-row batches for 15s.
DURATION_SECONDS=15 CONCURRENCY=32 BATCH_SIZE=200 BASE_URL="$BASE_URL" node scripts/benchmark.mjs > temp/drill-bench.json 2>&1 &
bench_pid=$!
sleep 4

started_sig_before="$(docker inspect -f '{{.State.StartedAt}}' server_loger-api-1 2>/dev/null || echo unknown)"

# First SIGTERM mid-ingestion, then a second one a second later. The handler is
# idempotent (the app's shuttingDown guard ignores repeats), so a repeated signal
# must not turn a graceful exit into a kill or an error code.
docker kill --signal=SIGTERM server_loger-api-1 >/dev/null 2>&1 || true
sleep 1
docker kill --signal=SIGTERM server_loger-api-1 >/dev/null 2>&1 || true

# docker kill is a manual stop, so the compose restart policy does NOT fire
# after it — that is by design, and it is exactly what lets us observe the
# process's own exit code. docker wait reports the first exit it observes.
exit_code="$(timeout 30 docker wait server_loger-api-1 2>/dev/null)"
if [ -z "$exit_code" ]; then
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' server_loger-api-1 2>/dev/null || echo unknown)"
  note "docker wait raced; fell back to State.ExitCode from inspect"
fi
[ "$exit_code" = "0" ] \
  && pass "repeated SIGTERM ended in exit code 0 (graceful drain)" \
  || fail "exit code $exit_code after repeated SIGTERM (expected 0)"

# Bring the service back the way an operator would, then confirm it recovers.
docker start server_loger-api-1 >/dev/null 2>&1 || true
recovered_6=0
for _ in $(seq 1 30); do
  sleep 2
  if [ "$(status_of "$BASE_URL/health")" = "200" ]; then recovered_6=1; break; fi
done
[ "$recovered_6" = "1" ] && pass "health returned to 200 after restarting the SIGTERM'd container" || fail "health did not recover within 60s after restart"

# The benchmark exits 1 when it saw errors (requests failing while the process
# was down are expected); its JSON summary still carries the accepted count.
wait "$bench_pid" || true
sleep 2  # let the last acknowledged batch commit

accepted="$(node -e "const r=JSON.parse(require('fs').readFileSync('temp/drill-bench.json','utf8'));process.stdout.write(String(r.accepted))" 2>/dev/null || echo unknown)"
note "client accepted $accepted rows"

count_after="$(docker compose exec -T postgres psql -U logger -d logs -tAc "SELECT count(*) FROM logs WHERE timestamp >= now() - interval '30 days';" 2>/dev/null | tr -d '[:space:]')"
count_after="${count_after:-unknown}"
note "rows after SIGTERM: $count_after"

if [ "$count_before" != "unknown" ] && [ "$count_after" != "unknown" ] && [ "$accepted" != "unknown" ]; then
  delta=$((count_after - count_before))
  [ "$delta" = "$accepted" ] \
    && pass "every acknowledged row persisted (db +$delta = accepted $accepted)" \
    || fail "db +$delta != accepted $accepted (acknowledged rows lost)"
else
  fail "could not compute persisted-row delta (before=$count_before after=$count_after accepted=$accepted)"
fi

docker logs server_loger-api-1 2>&1 | grep -q '"event":"shutdown"' \
  && pass "app logged a graceful shutdown event" \
  || fail "no shutdown event in the api container logs"

started_sig_after="$(docker inspect -f '{{.State.StartedAt}}' server_loger-api-1 2>/dev/null || echo unknown)"
# docker kill is a manual stop, so the restart policy does not fire and
# RestartCount stays put — that is expected. What proves the signal was
# honoured is the exit code above, plus the new StartedAt after our start.
if [ "$started_sig_after" != "unknown" ] && [ "$started_sig_before" != "unknown" ] && [ "$started_sig_after" != "$started_sig_before" ]; then
  pass "SIGTERM honoured: old process exited, container started anew (StartedAt changed)"
else
  fail "StartedAt unchanged after SIGTERM + start ($started_sig_before -> $started_sig_after)"
fi

code="$(status_of "$BASE_URL/health")"
[ "$code" = "200" ] && pass "stack left healthy after the drill (health 200)" || fail "health is $code at the end of the SIGTERM drill"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "failure drill: PASS"
else
  echo "failure drill: FAIL ($FAILURES checks)"
  exit 1
fi
