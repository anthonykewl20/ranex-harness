#!/bin/bash
# §17.4 per-task startup: time `serve` until "listening" (full module load + init,
# NO model call, NO model spend). Isolates the trim's effect from model latency.
#
# Prereqs: same as head-to-head.sh (upstream worktree installed, key present).
set -u

FORK_DIR="${FORK_DIR:-/home/soultransit/devtony/ranex-harness}"
UPSTREAM_DIR="${UPSTREAM_DIR:-/tmp/opencode/upstream-bulky}"
WORK="${WORK:-/tmp/opencode/bench}"
RUNS="${RUNS:-3}"
BUN="${BUN:-$HOME/.bun/bin/bun}"

FORK_PKGS="$FORK_DIR/packages/ranex"
UP_PKGS="$UPSTREAM_DIR/packages/opencode"
mkdir -p "$WORK"

startup() { # $1=engine $2=iteration
  local engine="$1" i="$2"
  local home="$WORK/shome-$engine-$i" log="$WORK/slog-$engine-$i.txt"
  rm -rf "$home"; mkdir -p "$home"
  local pkgs="$UP_PKGS" extra_env=()
  if [ "$engine" = fork ]; then
    pkgs="$FORK_PKGS"
    extra_env=(RANEX_TASK_ID=s RANEX_EMIT="$WORK/semit-$i.jsonl")
  fi

  local start ms pid ready=""
  start=$(date +%s%3N)
  env -i PATH="/usr/bin:/bin" HOME="$home" LC_ALL=C "${extra_env[@]}" \
    timeout 60 "$BUN" run --cwd "$pkgs" --conditions=browser src/index.ts serve --port 0 \
    >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 600); do
    if grep -q "listening" "$log" 2>/dev/null; then ready=yes; break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  ms=$(( $(date +%s%3N) - start ))
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  echo "$engine startup$i ready=${ready:-no} wall_ms=$ms"
}

echo "runs=$RUNS fork=$FORK_DIR upstream=$UPSTREAM_DIR"
for i in $(seq 1 "$RUNS"); do startup fork "$i"; startup upstream "$i"; done
