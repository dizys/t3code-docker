#!/usr/bin/env bash
# Run two independent checks, retaining both logs and waiting for both even if
# one fails. Call t3_parallel_cleanup from the caller's EXIT trap as well.
T3_PARALLEL_DIR=""
T3_PARALLEL_PIDS=()

t3_parallel_cleanup() {
  if [ "${#T3_PARALLEL_PIDS[@]}" -gt 0 ]; then
    kill "${T3_PARALLEL_PIDS[@]}" 2>/dev/null || true
    wait "${T3_PARALLEL_PIDS[@]}" 2>/dev/null || true
    T3_PARALLEL_PIDS=()
  fi
  if [ -n "$T3_PARALLEL_DIR" ]; then
    rm -rf -- "$T3_PARALLEL_DIR"
    T3_PARALLEL_DIR=""
  fi
}

t3_parallel_pair() {
  local log=$1 first=$2 second=$3 result=0 index
  T3_PARALLEL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3-audit-pair.XXXXXX")" || return 1
  "$first" >"$T3_PARALLEL_DIR/first.log" 2>&1 &
  T3_PARALLEL_PIDS+=("$!")
  "$second" >"$T3_PARALLEL_DIR/second.log" 2>&1 &
  T3_PARALLEL_PIDS+=("$!")
  for index in "${!T3_PARALLEL_PIDS[@]}"; do
    wait "${T3_PARALLEL_PIDS[$index]}" || result=1
    unset 'T3_PARALLEL_PIDS[index]'
  done
  T3_PARALLEL_PIDS=()
  cat "$T3_PARALLEL_DIR/first.log" "$T3_PARALLEL_DIR/second.log" >>"$log" || result=1
  t3_parallel_cleanup
  return "$result"
}
