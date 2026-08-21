#!/usr/bin/env bash
# Sequential 3x benchmark driver. Runs the exact command given, then archives
# the report and log per run.
set -u
cd /home/quta/Desktop/delete/foothill_logs_server
OUT=bench-runs

for i in 1 2 3; do
  echo "=== RUN $i START $(date -Is) ===" | tee -a "$OUT/driver.log"
  rm -f benchmark-report.json
  START=$(date +%s)
  npx --yes github:Ahmad-Abbas-Foothill/logs-benchmark-cli \
      --compose ./docker-compose.yml \
      --full \
      --seed 6122026 \
      --runner docker \
      --json benchmark-report.json \
      --generator-cpus 4 \
      > "$OUT/run${i}.log" 2>&1
  RC=$?
  END=$(date +%s)
  echo "=== RUN $i END $(date -Is) rc=$RC elapsed=$((END-START))s ===" | tee -a "$OUT/driver.log"
  if [ -f benchmark-report.json ]; then
    cp benchmark-report.json "$OUT/run${i}.json"
    echo "run $i: report saved ($(wc -c < "$OUT/run${i}.json") bytes)" | tee -a "$OUT/driver.log"
  else
    echo "run $i: NO REPORT PRODUCED" | tee -a "$OUT/driver.log"
  fi
done
echo "=== ALL RUNS DONE $(date -Is) ===" | tee -a "$OUT/driver.log"
