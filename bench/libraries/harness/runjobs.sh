#!/usr/bin/env bash
# Execute this VM's job list sequentially (one measurement at a time per VM).
#   bash bench/runjobs.sh jobs.txt <vm-id>
# Job lines: "scaling <lib> <cores>" | "ops <lib> <op>" | "mem <lib>"
# Methodology: scaling -> taskset to N CPUs; ops -> taskset to 1 CPU; 5 repeats
# (jsdom 3); JS pools use 8-page chunks and a 512 MB per-worker old-space cap;
# rusteerio uses extractAll in 128-page batches, 4 in flight. Ops run with a
# 16 GB V8 heap limit (jsdom exhausts the 4 GB default with the corpus resident).
set -u
cd "$(dirname "$0")/.."
JOBS=$1 VM=$2
export HEAP_MB=512 CHUNK=8 BATCH=128 INFLIGHT=4
tag() { python3 -c "import json,sys; d=json.loads(sys.stdin.read()); d['vm']='$VM'; print(json.dumps(d))"; }
while read -r kind lib arg; do
  [ -z "$kind" ] && continue
  reps=5; [ "$lib" = jsdom ] && reps=3
  case $kind in
    scaling)
      mode=pool; [ "$lib" = rusteerio ] && mode=native
      out=$(taskset -c 0-$((arg-1)) node bench/run_scaling.mjs "$lib" "$arg" "$mode" "$reps" 2>>results/errors.log) \
        && echo "$out" | tag >> results/scaling.jsonl \
        || echo "{\"lib\":\"$lib\",\"cores\":$arg,\"failed\":true,\"vm\":\"$VM\"}" >> results/scaling.jsonl ;;
    scalingpool)
      # rusteerio's sync API in a worker_threads pool, the same setup as the JS libraries
      out=$(taskset -c 0-$((arg-1)) node bench/run_scaling.mjs "$lib" "$arg" pool "$reps" 2>>results/errors.log) \
        && echo "$out" | tag >> results/scaling_pool.jsonl \
        || echo "{\"lib\":\"$lib\",\"cores\":$arg,\"failed\":true,\"vm\":\"$VM\"}" >> results/scaling_pool.jsonl ;;
    ops)
      out=$(taskset -c 0 node --max-old-space-size=16384 bench/run_ops.mjs "$lib" "$arg" "$reps" 2>>results/errors.log) \
        && echo "$out" | tag >> results/ops.jsonl ;;
    mem)
      out=$(node --expose-gc bench/run_mem.mjs "$lib" 500 2>>results/errors.log) \
        && echo "$out" | tag >> results/mem.jsonl ;;
  esac
  echo "$(date +%T) done $kind $lib $arg" >> results/progress.log
done < "$JOBS"
echo JOBS_DONE >> results/progress.log
