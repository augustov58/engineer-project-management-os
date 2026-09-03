import { apiFetch } from '../api';

export const dynamic = 'force-dynamic';

/**
 * The whole record, fetched by the Next server and handed to the browser as a
 * file (story 113).
 *
 * Without this route the export exists and nobody can reach it. The API is
 * bound to loopback and no browser calls it (ADR-0020), so `GET /v1/export`
 * is reachable only from inside the deployment — an export the engineer
 * cannot fetch does not answer "changing employers does not mean losing the
 * record". This is the door, and it is the same shape as the bytes proxies:
 * `apiFetch` is the only thing that reaches the API, because it is the only
 * place the secret is attached.
 *
 * There is deliberately **no path parameter**. The bytes proxies encode an id
 * because Next decodes `%2F` out of a segment before the handler sees it, and
 * interpolating one raw turns a proxy into an open GET proxy for every API
 * route. This route takes nothing from the caller at all, so that class of
 * mistake has nowhere to enter.
 */
export async function GET() {
  const upstream = await apiFetch('/export', { cache: 'no-store' });

  if (!upstream.ok) {
    // The export failing is the API failing — there is no "not found" for it,
    // since an empty database still exports every table.
    return new Response(null, { status: 502 });
  }

  /**
   * Named for the day it was taken, so two exports do not overwrite each other
   * in a downloads folder. The date is the browser's, which is the one clock
   * this file is allowed to read: `apps/api` reads the injected `TimeSource`
   * for anything persisted (ADR-0022), and a filename is not persisted.
   */
  const day = new Date().toISOString().slice(0, 10);

  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="epmos-export-${day}.json"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
