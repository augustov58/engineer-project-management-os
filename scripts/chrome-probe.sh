#!/bin/bash
# The probe above, run as the user that actually serves.
#
# `fly ssh console` lands as root, and Chrome refuses to start its sandbox as
# root — which is the whole reason the image runs as uid 10001. This drops to
# that user the same way `entrypoint.sh` does, HOME included, so what the probe
# reports is what the report renderer would get.
#
# The probe is passed as source rather than as a path because Node resolves a
# bare specifier from the *importing file's* directory, and `puppeteer` is a
# dependency of `apps/api` — a file under `scripts/` cannot see it. With
# `--eval` the resolution base is the working directory instead.
set -e
cd /home/app/src/apps/api
exec setpriv --reuid=10001 --regid=10001 --init-groups \
  env HOME=/home/app node --input-type=module \
  --eval "$(cat /home/app/src/scripts/chrome-probe.mjs)"
