#!/usr/bin/env bash
# Follow-up set at --generator-cpus 6, run because the CLI explicitly warned
# that k6 could not start all scheduled iterations at 4.
set -u
cd /home/quta/Desktop/delete/foothill_logs_server
OUT=bench-runs
G=6

for i in 1 2 3; do
  echo "=== G6 RUN $i START $(date -Is) ===" | tee -a "$OUT/driver6.log"
  rm -f benchmark-report.json
  START=$(date +%s)
  npx --yes github:Ahmad-Abbas-Foothill/logs-benchmark-cli \
      --compose ./docker-compose.yml \
      --full \
      --seed 6122026 \
      --runner docker \
      --json benchmark-report.json \
      --generator-cpus $G \
      > "$OUT/g6run${i}.log" 2>&1
  RC=$?
  END=$(date +%s)
  echo "=== G6 RUN $i END $(date -Is) rc=$RC elapsed=$((END-START))s ===" | tee -a "$OUT/driver6.log"
  [ -f benchmark-report.json ] && cp benchmark-report.json "$OUT/g6run${i}.json" \
    && echo "g6 run $i: report saved" | tee -a "$OUT/driver6.log" \
    || echo "g6 run $i: NO REPORT" | tee -a "$OUT/driver6.log"
done
echo "=== G6 ALL RUNS DONE $(date -Is) ===" | tee -a "$OUT/driver6.log"
