import { apiFetch } from '../../../api';

export const dynamic = 'force-dynamic';

/**
 * A recording's audio, fetched by the Next server and passed straight on.
 *
 * Every call to the API is made by the Next server rather than by the browser,
 * for the reason the photo byte proxy exists: an `<audio>` pointed at
 * `NEXT_PUBLIC_API_URL` would play on this machine and fail on the phone, and
 * it would be the one request in the product going around whatever ADR-0020
 * eventually puts in front of the API.
 *
 * The type is one of three the API refuses to store otherwise, and the browser
 * is told not to look for a fourth.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Encoded, and not interpolated raw. Next decodes `%2F` and `%23` out of the
  // path before this sees them, so `..%2Fexposure%23` would arrive here as a
  // segment that walks up and out — turning this route into an open GET proxy
  // for every route on an API deliberately bound to loopback. Found and fixed
  // on the photo route (ADR-0032); this is the same route written again.
  const upstream = await apiFetch(
    `/voice-captures/${encodeURIComponent(id)}/audio`,
    { cache: 'no-store' },
  );

  if (!upstream.ok) {
    // A recording that is not there is a 404 here too; anything else is the
    // API failing, which is not the same thing and should not read as one.
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
