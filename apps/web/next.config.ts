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
};

export default nextConfig;
