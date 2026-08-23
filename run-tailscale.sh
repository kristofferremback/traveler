#!/usr/bin/env bash
# Run Traveler on this machine and expose it to the tailnet over HTTPS.
#
# HTTPS rather than a plain LAN address on purpose: geolocation is a secure-context
# API, so "use my position" and the whole Nearby page fail silently over http://.
# Tailscale terminates TLS with a real certificate, which makes them work on a phone.
#
# The server itself stays on loopback. Only Tailscale can reach it.
set -euo pipefail

PORT="${PORT:-3000}"
TS_PORT="${TS_PORT:-8443}"
cd "$(dirname "$0")"

# The repo-root .env is the one place to keep settings for this script; the server is
# started from packages/server, where Bun would not find it on its own.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

TS_HOST="$(tailscale status --json | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
TS_URL="https://${TS_HOST}:${TS_PORT}"

# Passkeys are registered against this hostname and invite links are built from it, so
# it has to be the address the phone actually opens: the tailnet one, unless overridden.
export AUTH_BASE_URL="${AUTH_BASE_URL:-$TS_URL}"

# Production mode refuses to start without a signing secret. Generate one the first time
# and keep it in .env, so sessions and passkeys survive a restart; rotating it signs
# everyone out, which is the intended emergency lever.
if [ -z "${AUTH_SECRET:-}" ]; then
  AUTH_SECRET="$(openssl rand -base64 32)"
  printf '\nAUTH_SECRET=%s\n' "$AUTH_SECRET" >> .env
  echo "Generated AUTH_SECRET and saved it to .env"
fi
export AUTH_SECRET

bun run build

cleanup() {
  echo
  echo "Removing the tailnet proxy on :${TS_PORT}"
  tailscale serve --https="${TS_PORT}" off || true
}
trap cleanup EXIT INT TERM

# --https on its own port so any existing `tailscale serve` mapping on / is untouched.
tailscale serve --bg --https="${TS_PORT}" --yes "http://127.0.0.1:${PORT}"

echo
echo "  ${TS_URL}"
echo
echo "  First account: in another shell, AUTH_BASE_URL=${TS_URL} bun run invite you@example.com"
echo
echo "  Tailnet only. Ctrl-C stops the server and removes the proxy."
echo

cd packages/server
NODE_ENV=production HOST=127.0.0.1 PORT="${PORT}" bun src/index.ts
