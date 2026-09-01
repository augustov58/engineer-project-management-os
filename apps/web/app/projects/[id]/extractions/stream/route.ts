import { apiPath } from '../../../../api';

export const dynamic = 'force-dynamic';

/**
 * A job's extractions as they move, proxied so the browser never calls the
 * API.
 *
 * The memory stream written a fourth time (issues #12, #13, #18), with the
 * same `encodeURIComponent` already in it: Next decodes `%2F` and `%23` out
 * of a path segment before this sees them, so an id interpolated raw would
 * make this an open GET proxy for every route on the API.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upstream = await fetch(
    apiPath(`/projects/${encodeURIComponent(id)}/extractions/stream`),
    {
      cache: 'no-store',
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
