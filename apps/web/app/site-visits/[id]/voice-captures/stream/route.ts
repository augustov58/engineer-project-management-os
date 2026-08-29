import { apiPath } from '../../../../api';

export const dynamic = 'force-dynamic';

/**
 * Transcription progress, streamed from the API through this server.
 *
 * An `EventSource` in the browser can only reach this origin — the API is
 * bound to loopback and the phone is on the network, which is the invariant
 * the whole app is written around. So the stream is proxied exactly the way a
 * photograph's bytes are, and for the same reason.
 *
 * `upstream.body` is passed through rather than buffered, which is what makes
 * it a stream and not one silent block at the end.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upstream = await fetch(
    apiPath(`/site-visits/${encodeURIComponent(id)}/voice-captures/stream`),
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
