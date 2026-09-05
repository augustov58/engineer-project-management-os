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

# The model provider's credential, on the volume for the same reason the object
# store is: everything else on this machine is the image, and the image is
# replaced by every deploy. The Pi SDK resolves its auth store to
# `PI_CODING_AGENT_DIR` or, failing that, `$HOME/.pi/agent` — and $HOME here is
# inside the image, so a credential left at the default would be authenticated
# once and gone on the next `fly deploy`.
#
# Created and chowned here rather than by the login, because `fly ssh console`
# lands as root: without this the credential would be written root-owned into a
# directory the application cannot read (ADR-0041 removed the agent's file
# tools, so it has no way to tell you that is why it failed).
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  mkdir -p "$PI_CODING_AGENT_DIR"
  chown -R 10001:10001 "$PI_CODING_AGENT_DIR"
fi

# `setpriv` changes the uid and nothing else, so HOME would still be /root —
# and the pnpm the build put in corepack's cache lives under /home/app. Without
# this the first `pnpm` call dies with EACCES on /root/.cache and the machine
# restart-loops to its limit, which is exactly what the first deploy did.
export HOME=/home/app

exec setpriv --reuid=10001 --regid=10001 --init-groups ./scripts/start.sh
