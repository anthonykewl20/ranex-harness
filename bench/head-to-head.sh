#!/bin/bash
# §17.4 head-to-head: trimmed fork vs bulky upstream on the SAME delegated task.
# Measures per-task wall-time, completion (AGENT_NOTE.txt), and provider stalls.
#
# Prereqs:
#   - bulky upstream checked out + installed at $UPSTREAM_DIR, e.g.:
#       git -C "$FORK_DIR" worktree add --detach /tmp/upstream-bulky 012c2f57f9
#       (cd /tmp/upstream-bulky && bun install)
#   - an OpenRouter key at $KEY_FILE (never committed).
set -u

FORK_DIR="${FORK_DIR:-/home/soultransit/devtony/ranex-harness}"
UPSTREAM_DIR="${UPSTREAM_DIR:-/tmp/opencode/upstream-bulky}"
KEY_FILE="${KEY_FILE:-$HOME/.secrets/openrouter-key}"
MODEL="${MODEL:-openrouter/cohere/north-mini-code:free}"
WORK="${WORK:-/tmp/opencode/bench}"
RUNS="${RUNS:-3}"
TIMEOUT="${TIMEOUT:-150}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
PROMPT="Create a file named AGENT_NOTE.txt at the repository root containing the single line: delegated work happened. Do not do anything else."

KEY="$(cat "$KEY_FILE")"
FORK_PKGS="$FORK_DIR/packages/opencode"
UP_PKGS="$UPSTREAM_DIR/packages/opencode"
mkdir -p "$WORK"

fresh_repo() {
  rm -rf "$1"; mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" config user.email bench@example.invalid
  git -C "$1" config user.name Bench
  git -C "$1" config commit.gpgsign false
  echo base > "$1/base.txt"
  git -C "$1" add -A && git -C "$1" commit -qm base
}

run_engine() { # $1=engine(fork|upstream) $2=iteration
  local engine="$1" i="$2"
  local repo="$WORK/repo-$engine-$i" home="$WORK/home-$engine-$i"
  local emit="$WORK/emit-$engine-$i.jsonl" log="$WORK/log-$engine-$i.txt"
  fresh_repo "$repo"; rm -rf "$home"; mkdir -p "$home"; rm -f "$emit"

  local pkgs="$UP_PKGS" extra_env=()
  if [ "$engine" = fork ]; then
    pkgs="$FORK_PKGS"
    extra_env=(RANEX_TASK_ID="bench-$i" RANEX_EMIT="$emit")
  fi

  local start end ms rc
  start=$(date +%s%3N)
  env -i PATH="/usr/bin:/bin" HOME="$home" LC_ALL=C \
      OPENROUTER_API_KEY="$KEY" "${extra_env[@]}" \
      timeout "$TIMEOUT" "$BUN" run --cwd "$pkgs" --conditions=browser src/index.ts \
      run --dir "$repo" --model "$MODEL" --auto "$PROMPT" \
      >"$log" 2>&1
  rc=$?
  end=$(date +%s%3N); ms=$((end - start))

  local note="no"; [ -f "$repo/AGENT_NOTE.txt" ] && note="yes"
  echo "$engine run$i rc=$rc wall_ms=$ms note_created=$note"
}

echo "model=$MODEL runs=$RUNS timeout=${TIMEOUT}s fork=$FORK_DIR upstream=$UPSTREAM_DIR"
for i in $(seq 1 "$RUNS"); do
  run_engine fork "$i"
  run_engine upstream "$i"
done
