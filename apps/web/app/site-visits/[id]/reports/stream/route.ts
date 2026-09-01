import { apiPath } from '../../../../api';
import { edgeHeaders } from '../../../../edge-secret';

export const dynamic = 'force-dynamic';

/**
 * A walk's reports as they render, proxied so the browser never calls the API.
 *
 * The recordings stream written again (issue #12), with the same
 * `encodeURIComponent` already in it: Next decodes `%2F` and `%23` out of a
 * path segment before this sees them, so an id interpolated raw would make
 * this an open GET proxy for every route on the API.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upstream = await fetch(
    apiPath(`/site-visits/${encodeURIComponent(id)}/reports/stream`),
    {
      cache: 'no-store',
      headers: edgeHeaders(),
      // So closing the browser tab closes the API's stream too, rather than
      // leaving a poll running against a reader that has gone.
      signal: request.signal,
    },
  );

  if (!upstream.ok) {
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
