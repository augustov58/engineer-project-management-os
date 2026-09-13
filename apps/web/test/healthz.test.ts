/**
 * The check that watches the process it is a check on (issue #106, ADR-0052).
 *
 * The platform check was `GET /sign-in` — before that `/unlock` — which is
 * served entirely by Next and calls nothing. It proved the Next server was
 * serving and said nothing about the API, so an API that was OOM-killed or
 * wedged left a machine Fly considered healthy and never restarted, serving a
 * frontend whose every read and write failed (issue #94).
 *
 * `/healthz` goes through `apiFetch`, which is the one door (ADR-0055), so the
 * check reaches the API without a second one being opened beside it.
 *
 * What it deliberately does **not** prove, at equal length: that the API's
 * database and Redis are up. `GET /v1/health` answers that and is gated, and
 * the gate takes exactly one named exception — "one is a property a test can
 * hold and two is the start of a list" — so a check carrying no session gets
 * the gate's 401 rather than the queue depth. An answer is the signal: the
 * process accepted the connection, ran its gate and replied, which is the half
 * of #94 that was invisible. A silent API is the other half and is what this
 * turns red.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { productSources } from './sources';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../app/api', () => ({ apiFetch }));

afterEach(() => {
  vi.resetAllMocks();
});

/** Imported here and not at the top: the mock has to be in place first. */
async function check(): Promise<Response> {
  const { GET } = await import('../app/healthz/route');
  return GET();
}

test('the API answering at all is the machine being healthy', async () => {
  apiFetch.mockResolvedValue(new Response(null, { status: 200 }));

  const response = await check();

  expect(response.status).toBe(200);
  expect(apiFetch).toHaveBeenCalledWith('/health', expect.anything());
});

test("the gate's own refusal is an answer, because the process gave it", async () => {
  // The check presents no session, so the gated health route answers 401.
  // Reading that as unhealthy would fail the check forever and restart the
  // machine in a loop; reading it as an answer is what it is.
  apiFetch.mockResolvedValue(new Response(null, { status: 401 }));

  expect((await check()).status).toBe(200);
});

test('a server error is still an answer, and the API that gave it is alive', async () => {
  apiFetch.mockResolvedValue(new Response(null, { status: 500 }));

  expect((await check()).status).toBe(200);
});

test('an API that answers nothing fails the check', async () => {
  // What a connection refused by a dead process looks like from here, and
  // what a request abandoned at the timeout looks like too.
  for (const silence of [
    new TypeError('fetch failed'),
    new DOMException('The operation was aborted.', 'TimeoutError'),
  ]) {
    apiFetch.mockRejectedValue(silence);

    expect((await check()).status).toBe(503);
  }
});

test('the check gives the caller nothing but the status', async () => {
  // `/healthz` is reachable without a session, which is what a platform check
  // needs and as far as it goes. ADR-0020 gated `GET /v1/health` because "an
  // anonymous caller learning whether this instance's database and Redis are
  // up is a fact worth nothing to the engineer and something to somebody
  // else", and that reason survives into this file: the one bit Fly needs is
  // the status line, and the body carries nothing on top of it.
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ queue: { waiting: 7 } })));

  expect(await (await check()).text()).toBe('');
});

test('the path the proxy lets past is the path a route answers on', () => {
  // Two halves that must agree and are written in two files: renaming the
  // directory without the proxy leaves the check redirected to sign-in, and
  // Fly would read a 307 as a machine to restart.
  const paths = productSources().map((source) => source.path);
  expect(paths).toContain('app/healthz/route.ts');

  const proxySource = productSources().find((source) => source.path === 'proxy.ts');
  expect(proxySource?.text).toContain("'/healthz'");
});

test('and it is the path the platform actually checks', () => {
  // Reaching out of the package for a deployment file, which this suite does
  // nowhere else. The drift it catches is the whole of issue #94: a check
  // pointing at a path that proves the wrong thing is green for as long as the
  // wrong thing lives, and nothing else here would ever say so.
  const fly = readFileSync(resolve(process.cwd(), '../../fly.toml'), 'utf8');

  expect(fly).toMatch(/^\s*path = "\/healthz"$/m);
});
