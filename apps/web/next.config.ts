import { networkInterfaces } from 'node:os';
import type { NextConfig } from 'next';

/**
 * Every IPv4 address this machine actually has on a real network.
 *
 * Read at config load rather than written down, so the app stays viewable
 * from another device after a DHCP lease hands this machine a new address.
 */
function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const candidates of Object.values(networkInterfaces())) {
    for (const candidate of candidates ?? []) {
      if (candidate.family === 'IPv4' && !candidate.internal) {
        addresses.push(candidate.address);
      }
    }
  }
  return addresses;
}

/**
 * The one shared secret in front of every route (ADR-0020).
 *
 * Checked here because this file is the only thing Next loads before it
 * serves anything — `next dev`, `next build` and `next start` all read it —
 * so a missing secret is a refusal to boot rather than a deployment that
 * comes up open. `pnpm dev` copies `.env.example` to `.env`, which carries a
 * development value; a deployment supplies a real one from its secret
 * manager, and rotating it is a redeploy.
 */
if (
  process.env['EDGE_SECRET'] === undefined ||
  process.env['EDGE_SECRET'] === ''
) {
  throw new Error(
    'EDGE_SECRET is not set. Copy apps/web/.env.example to apps/web/.env.',
  );
}

/**
 * And the value `.env.example` carries is refused in production, because it
 * is in source and therefore known. `pnpm dev` copies that file to `.env`, so
 * a deployment that shipped the working tree would otherwise pass every check
 * above while being open to anybody who has read this repository. Next sets
 * `NODE_ENV` itself for `build` and `start`, so this half always fires.
 */
if (
  process.env.NODE_ENV === 'production' &&
  process.env['EDGE_SECRET'] === 'development-only-not-a-secret'
) {
  throw new Error(
    'EDGE_SECRET is the development value from apps/web/.env.example, which ' +
      'is in source and so is known. Generate one at deploy time.',
  );
}

/**
 * `next dev` already listens on every interface, but it refuses to serve its
 * own `/_next/*` assets to a browser whose origin is not on its allow list.
 * Loading the app from another device on the network therefore returned the
 * server-rendered HTML and then 403'd on every script: a page that looks
 * present and is entirely dead. Next allows `localhost` itself; this adds
 * this machine's own addresses.
 *
 * Development only, and it widens nothing else. The API, PostgreSQL and Redis
 * all stay bound to loopback, and every call to the API is made by the Next
 * server on this host rather than by the browser — so a second device needs
 * no access to port 3001 at all.
 */
const nextConfig: NextConfig = {
  allowedDevOrigins: lanAddresses(),

  /**
   * A server action's body defaults to one megabyte, which no photograph off a
   * phone fits in — the picker would have refused every real file while
   * accepting the one-pixel PNG the API tests use.
   *
   * Sixty-four covers the largest thing this product takes, which is a
   * document version: the API caps one at forty-eight mebibytes, being the
   * 86-sheet drawing set issue #17 names by hand. Photographs still send one
   * request per file — a hundred of them in one body is not a request anybody
   * should make — and a document is one file, so this is a per-*file* limit
   * either way.
   *
   * It is **one number for every server action**, which Next gives no way to
   * scope per route, so raising it for documents raised it for photographs
   * too. That costs nothing at the record: `photoRoutes` sets its own
   * `bodyLimit` at twelve mebibytes and refuses a larger file whatever this
   * says. What changed is only where an oversized photograph is refused —
   * by the API rather than by the Next server, after buffering more of it.
   */
  experimental: { serverActions: { bodySizeLimit: '64mb' } },
};

export default nextConfig;
