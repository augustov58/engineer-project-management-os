import { apiFetch } from '../../../api';

export const dynamic = 'force-dynamic';

/**
 * A project conversation's progress, streamed from the API through this server
 * (issue #121).
 *
 * The walk's handler by its own id, and for its reasons: an `EventSource` in
 * the browser can only reach this origin, the API is bound to loopback, and
 * `upstream.body` is passed through rather than buffered so it is a stream and
 * not one silent block at the end.
 *
 * Two handlers and not one, because the two conversations are addressed
 * differently — a walk has exactly one and a project has any number, so what a
 * caller has in hand is a visit's id there and a conversation's here.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upstream = await apiFetch(
    `/conversations/${encodeURIComponent(id)}/stream`,
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
