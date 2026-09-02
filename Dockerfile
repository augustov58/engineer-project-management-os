# The deployment ADR-0003 called for, built for the first time (issue #56).
#
# One image running both halves: the API on loopback and the Next server on
# every interface. That is not a packaging convenience — it is ADR-0020's
# arrangement made literal. No browser reaches the API, so the API never needs
# an address outside this container, and the only listener the internet can
# see is the one the gate sits in front of.
FROM node:22-bookworm-slim

# Chrome's shared libraries, and `unzip` — without which puppeteer's
# postinstall fails to extract Chrome and `pnpm install` still exits 0, so
# the image builds and only the report renderer is broken, at runtime.
# Chrome's shared libraries. The report renderer launches Chrome under its
# **default sandbox**, which ADR-0035 kept deliberately — the page inlines
# photographs that arrived from outside this product, and `--no-sandbox` is
# the flag that would make one of them worth worrying about. Keeping the
# sandbox is why this image runs as a non-root user below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      unzip \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Chrome's sandbox needs this process not to be root. The uid is fixed so the
# volume mounted at /data keeps the same owner across deploys.
RUN useradd --uid 10001 --create-home --shell /bin/bash app
USER app
WORKDIR /home/app/src

# Manifests first, so a source edit does not re-download Chrome.
COPY --chown=app:app package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=app:app apps/api/package.json apps/api/
COPY --chown=app:app apps/web/package.json apps/web/
# The schema too: `apps/api`'s postinstall is `prisma generate`, which needs it.
COPY --chown=app:app apps/api/prisma apps/api/prisma

# `puppeteer` is in `onlyBuiltDependencies`, so this is where Chrome is
# fetched — into /home/app/.cache/puppeteer, which is why the runtime user and
# the build user have to be the same one.
RUN pnpm install --frozen-lockfile

COPY --chown=app:app . .

# `prisma generate` again, deliberately: `**/generated` is in `.dockerignore`,
# so the client this image runs is generated here rather than copied off
# whatever the build machine happened to have.
RUN pnpm --filter api exec prisma generate

# `next build` refuses to load its config without a secret (ADR-0020), and
# refuses the development one under NODE_ENV=production. The real secret is a
# Fly secret read at runtime — `edgeSecret()` reads `process.env['EDGE_SECRET']`
# inside a function and with bracket notation, so nothing here is baked in.
# This value exists only to get the config past its own guard.
RUN EDGE_SECRET="$(head -c 32 /dev/urandom | base64)" pnpm --filter web build

ENV NODE_ENV=production
EXPOSE 3000

# Back to root for the entrypoint, which chowns the mounted volume and then
# drops to uid 10001 for good. Everything above this line was built as that
# user, which is what puts Chrome in a cache it can still read.
USER root
CMD ["./scripts/entrypoint.sh"]
