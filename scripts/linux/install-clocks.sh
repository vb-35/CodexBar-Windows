#!/usr/bin/env bash
# Installs the multi-user clock starter on Ubuntu with pinned private copies of the Codex and Claude Code CLIs.
#
#   sudo bash scripts/linux/install-clocks.sh [--claude-version <version>] [--codex-version <version>] [--no-timer]
#
# Versions default to the latest release at install time and stay fixed until this script is run again.
set -euo pipefail

PREFIX=/opt/codexbar-clocks
CLAUDE_VERSION=latest
CODEX_VERSION=latest
TIMER=1

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude-version) CLAUDE_VERSION="${2:?}"; shift 2 ;;
    --codex-version) CODEX_VERSION="${2:?}"; shift 2 ;;
    --no-timer) TIMER=0; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run with sudo."
NODE="$(command -v node)" || die "Node.js 22 or newer is required."
command -v npm >/dev/null || die "npm is required."
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 22 ]] || die "Node.js 22 or newer is required (found $("$NODE" --version))."
# Workers run as each user, so a Node.js installed under root's home (nvm) cannot start them.
runuser -u nobody -- test -x "$NODE" || die "$NODE is not executable by other users; install Node.js system-wide."

if ! command -v make >/dev/null || ! command -v g++ >/dev/null || ! command -v python3 >/dev/null; then
  echo "Installing build tools for node-pty…"
  apt-get update -qq && apt-get install -y -qq build-essential python3
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "Compiling…"
cp -r "$REPO/src" "$REPO/tsconfig.main.json" "$REPO/package.json" "$REPO/package-lock.json" "$BUILD/"
# Only the TypeScript compiler is needed; skipping scripts avoids downloading Electron.
(cd "$BUILD" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npx --no-install tsc -p tsconfig.main.json)
PTY_VERSION="$("$NODE" -p "require('$BUILD/node_modules/node-pty/package.json').version")"

exact() { "$NODE" -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(Array.isArray(v) ? v.at(-1) : v)' \
  < <(npm view "$1@$2" version --json); }
CLAUDE_VERSION="$(exact @anthropic-ai/claude-code "$CLAUDE_VERSION")"
CODEX_VERSION="$(exact @openai/codex "$CODEX_VERSION")"

echo "Installing to $PREFIX (Claude Code $CLAUDE_VERSION, Codex $CODEX_VERSION)…"
install -d -m 755 "$PREFIX" "$PREFIX/cli"
rm -rf "$PREFIX/dist"
cp -r "$BUILD/dist" "$PREFIX/dist"
printf '{ "private": true, "dependencies": { "node-pty": "%s" } }\n' "$PTY_VERSION" > "$PREFIX/package.json"
(cd "$PREFIX" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
printf '{ "private": true }\n' > "$PREFIX/cli/package.json"
(cd "$PREFIX/cli" && npm install --save-exact --no-audit --no-fund --loglevel=error \
  "@anthropic-ai/claude-code@$CLAUDE_VERSION" "@openai/codex@$CODEX_VERSION")
chmod -R a+rX,go-w "$PREFIX"

for unit in codexbar-clocks.service codexbar-clocks.timer; do
  sed -e "s#@NODE@#$NODE#g" -e "s#@PREFIX@#$PREFIX#g" "$REPO/scripts/linux/$unit" > "/etc/systemd/system/$unit"
  chmod 644 "/etc/systemd/system/$unit"
done
systemctl daemon-reload
if [[ $TIMER -eq 1 ]]; then systemctl enable --now codexbar-clocks.timer; fi

echo
echo "Done. Accounts found:"
"$NODE" "$PREFIX/dist/main/linux-clocks.js" --dry-run || true
echo
echo "Run now:  sudo systemctl start codexbar-clocks.service && journalctl -u codexbar-clocks.service -n 50"
