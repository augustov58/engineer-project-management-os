#!/bin/bash
# Both halves of the deployment, and the migration in front of them.
#
# The API listens on loopback only (`index.ts` binds 127.0.0.1) and Next
# listens on every interface, which is ADR-0020's arrangement: the gate is in
# front of the only thing reachable, and the API has no address the internet
# could use even if the gate were wrong.
set -e

# bash and not sh: `wait -n` below is a bash builtin, and dash exits
# "Illegal option -n" the moment either half of the deployment stops.

# Fly's Managed Postgres speaks plaintext on the private network: 6PN traffic
# is already WireGuard-encrypted end to end, and its pgbouncer offers no TLS,
# so Prisma's default attempt dies with
# `P1011: Error opening a TLS connection: unexpected EOF`.
#
# Appended here rather than encoded into the secret, so that a transport choice
# is a readable line in `fly.toml` instead of an invisible suffix on a
# credential, and changing it never means rewriting the credential. Unset means
# unchanged, which is what `pnpm dev` and the test harness get.
if [ -n "${DATABASE_SSLMODE:-}" ]; then
  case "$DATABASE_URL" in
    *sslmode=*) ;;
    *\?*) export DATABASE_URL="$DATABASE_URL&sslmode=$DATABASE_SSLMODE" ;;
    *) export DATABASE_URL="$DATABASE_URL?sslmode=$DATABASE_SSLMODE" ;;
  esac
fi

pnpm --filter api migrate:deploy

pnpm --filter api start &
api=$!
pnpm --filter web start &
web=$!

# Either half exiting takes the machine down rather than leaving a half-served
# deployment up: Fly restarts it, and a half that cannot boot says why in the
# logs instead of being masked by the other half still answering.
trap 'kill -TERM "$api" "$web" 2>/dev/null' TERM INT
wait -n "$api" "$web"
kill -TERM "$api" "$web" 2>/dev/null || true
wait
