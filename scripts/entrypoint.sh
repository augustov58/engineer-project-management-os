#!/bin/bash
# Runs as root and stays root for exactly one thing.
#
# A Fly volume arrives owned by root, and the application runs as uid 10001 —
# not for tidiness but because Chrome's sandbox refuses to start as root, and
# ADR-0035 kept that sandbox deliberately: the report inlines photographs that
# arrived from outside this product. So: make the mount writable by that user,
# then drop to it and never come back.
set -e

store="${OBJECT_STORE_DIR:-/data/objects}"
mkdir -p "$store"
chown -R 10001:10001 "$store"

# `setpriv` changes the uid and nothing else, so HOME would still be /root —
# and the pnpm the build put in corepack's cache lives under /home/app. Without
# this the first `pnpm` call dies with EACCES on /root/.cache and the machine
# restart-loops to its limit, which is exactly what the first deploy did.
export HOME=/home/app

exec setpriv --reuid=10001 --regid=10001 --init-groups ./scripts/start.sh
