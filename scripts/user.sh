#!/bin/bash
# The machine command, on the machine (issue #105, ADR-0055).
#
#   fly ssh console --app epmos-t1 -C "/home/app/src/scripts/user.sh create 'Your Name' you@example.com"
#   fly ssh console --app epmos-t1 -C "/home/app/src/scripts/user.sh reset you@example.com"
#
# This is the only way a deployment gets its first account — there is no route
# that could make one — and the only way back in when a password is gone. After
# the first account exists, every one after it is added at `/users` by somebody
# already signed in, and that is an audited mutation like any other.
#
# `fly ssh console` lands as root and the app runs as uid 10001, so this drops
# to that user the same way `entrypoint.sh` does, HOME included — otherwise the
# audit line and the row would be written by a process with a different view of
# the volume than the one that serves.
#
# `fly ssh console -C` is not a terminal, so the password is read from stdin.
# Pipe it in, and mind that a password on a command line is in your own shell's
# history:
#
#   printf %s "$PASSWORD" | fly ssh console --app epmos-t1 -C "…"
set -e
cd /home/app/src
exec setpriv --reuid=10001 --regid=10001 --init-groups \
  env HOME=/home/app pnpm --filter api user "$@"
