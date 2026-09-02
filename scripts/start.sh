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
