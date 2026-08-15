#!/usr/bin/env bash
set -euo pipefail

# opencode Korean IME Fix Installer
# https://github.com/anomalyco/opencode/issues/14371
#
# Patches opencode to prevent Korean (and other CJK) IME last character
# truncation when pressing Enter in Kitty and other terminals.
#
# Usage:
#   # Resolve the fork's current branch head to a commit, then pin it:
#   git ls-remote https://github.com/claudianus/opencode.git refs/heads/fix-zhipuai-coding-plan-thinking
#   FORK_REF=<full-40-char-commit-sha> ./patches/install-korean-ime-fix.sh
#   # or from a pipe (FORK_REF is still required):
#   curl -fsSL https://raw.githubusercontent.com/claudianus/opencode/fix-zhipuai-coding-plan-thinking/patches/install-korean-ime-fix.sh | FORK_REF=<sha> bash
#
# NOTE: this script refuses to run without FORK_REF. Building a floating
# branch HEAD would let the fork owner ship arbitrary new code into your
# opencode binary without your knowledge.

RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[38;5;214m'
MUTED='\033[0;2m'
NC='\033[0m'

RANEX_DIR="${RANEX_DIR:-$HOME/.opencode}"
RANEX_SRC="${RANEX_SRC:-$HOME/.opencode-src}"
FORK_REPO="${FORK_REPO:-https://github.com/claudianus/opencode.git}"
FORK_BRANCH="${FORK_BRANCH:-fix-zhipuai-coding-plan-thinking}"
# Pinned commit to build. Must be set explicitly; a floating HEAD is refused.
FORK_REF="${FORK_REF:-}"

info()  { echo -e "${MUTED}$*${NC}"; }
warn()  { echo -e "${ORANGE}$*${NC}"; }
err()   { echo -e "${RED}$*${NC}" >&2; }
ok()    { echo -e "${GREEN}$*${NC}"; }

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Error: $1 is required but not installed."
    exit 1
  fi
}

warn "WARNING: this script REPLACES your installed opencode binary with a"
warn "build compiled from a THIRD-PARTY fork: $FORK_REPO"
warn "Only continue if you trust that fork's maintainer."

need git
need bun

# The fork must be pinned to an exact commit before anything is built.
if [ -z "$FORK_REF" ]; then
  err "Error: FORK_REF is not set. Refusing to build a floating branch HEAD."
  err ""
  err "Resolve the commit you want, then re-run with it pinned, e.g.:"
  err "  git ls-remote $FORK_REPO refs/heads/$FORK_BRANCH"
  err "  FORK_REF=<full-40-char-commit-sha> $0"
  exit 1
fi
FORK_REF=$(printf '%s' "$FORK_REF" | tr '[:upper:]' '[:lower:]')
if [ "${#FORK_REF}" -ne 40 ] || ! printf '%s' "$FORK_REF" | grep -Eq '^[0-9a-f]{40}$'; then
  err "Error: FORK_REF must be a full 40-character commit SHA (got: $FORK_REF)."
  err "Resolve one with: git ls-remote $FORK_REPO refs/heads/$FORK_BRANCH"
  exit 1
fi
info "Building exact commit: $FORK_REF (branch: $FORK_BRANCH)"

# ── 1. Clone or update fork ────────────────────────────────────────────
if [ -d "$RANEX_SRC/.git" ]; then
  info "Updating existing source at $RANEX_SRC ..."
  git -C "$RANEX_SRC" fetch origin "$FORK_BRANCH"
else
  info "Cloning fork (shallow) to $RANEX_SRC ..."
  git clone --depth 1 --branch "$FORK_BRANCH" "$FORK_REPO" "$RANEX_SRC"
fi

# ── 2. Check out the pinned commit ────────────────────────────────────
if ! git -C "$RANEX_SRC" cat-file -e "$FORK_REF^{commit}" 2>/dev/null; then
  git -C "$RANEX_SRC" fetch origin "$FORK_REF"
fi
git -C "$RANEX_SRC" checkout --detach "$FORK_REF"
if [ "$(git -C "$RANEX_SRC" rev-parse HEAD)" != "$FORK_REF" ]; then
  err "Error: checked-out commit does not match pinned FORK_REF ($FORK_REF)."
  exit 1
fi
ok "Source pinned at $FORK_REF"

# ── 3. Verify the IME fix is present in source ────────────────────────
PROMPT_FILE="$RANEX_SRC/packages/ranex/src/cli/cmd/tui/component/prompt/index.tsx"
if [ ! -f "$PROMPT_FILE" ]; then
  err "Prompt file not found: $PROMPT_FILE"
  exit 1
fi

if grep -q "setTimeout(() => setTimeout" "$PROMPT_FILE"; then
  ok "IME fix already present in source."
else
  warn "IME fix not found. Applying patch ..."
  # Apply the fix: replace onSubmit={submit} with double-deferred version
  sed -i 's|onSubmit={submit}|onSubmit={() => {\n                // IME: double-defer so the last composed character (e.g. Korean\n                // hangul) is flushed to plainText before we read it for submission.\n                setTimeout(() => setTimeout(() => submit(), 0), 0)\n              }}|' "$PROMPT_FILE"
  if grep -q "setTimeout(() => setTimeout" "$PROMPT_FILE"; then
    ok "Patch applied."
  else
    err "Failed to apply patch. The source may have changed."
    exit 1
  fi
fi

# ── 4. Install dependencies ────────────────────────────────────────────
info "Installing dependencies (this may take a minute) ..."
cd "$RANEX_SRC"
bun install --frozen-lockfile 2>/dev/null || bun install

# ── 5. Build (current platform only) ──────────────────────────────────
info "Building opencode for current platform ..."
cd "$RANEX_SRC/packages/ranex"
bun run build --single

# ── 6. Install binary ──────────────────────────────────────────────────
mkdir -p "$RANEX_DIR/bin"

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
[ "$ARCH" = "aarch64" ] && ARCH="arm64"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
[ "$PLATFORM" = "darwin" ] && true
[ "$PLATFORM" = "linux" ] && true

BUILT_BINARY="$RANEX_SRC/packages/ranex/dist/opencode-${PLATFORM}-${ARCH}/bin/opencode"

if [ ! -f "$BUILT_BINARY" ]; then
  BUILT_BINARY=$(find "$RANEX_SRC/packages/ranex/dist" -name "opencode" -type f -executable 2>/dev/null | head -1)
fi

if [ -f "$BUILT_BINARY" ]; then
  if [ -f "$RANEX_DIR/bin/opencode" ]; then
    cp "$RANEX_DIR/bin/opencode" "$RANEX_DIR/bin/opencode.bak.$(date +%Y%m%d%H%M%S)"
  fi
  cp "$BUILT_BINARY" "$RANEX_DIR/bin/opencode"
  chmod +x "$RANEX_DIR/bin/opencode"
  ok "Installed to $RANEX_DIR/bin/opencode"
else
  err "Build failed - binary not found in dist/"
  info "Try running manually:"
  echo "  cd $RANEX_SRC/packages/ranex && bun run build --single"
  exit 1
fi

echo ""
ok "Done! Korean IME fix is now active."
echo ""
info "To uninstall and revert to the official release:"
echo "  curl -fsSL https://opencode.ai/install | bash"
echo ""
info "To update (re-pull and rebuild):"
echo "  $0"
