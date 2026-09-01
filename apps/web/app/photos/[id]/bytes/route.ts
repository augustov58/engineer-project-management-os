import { apiFetch } from '../../../api';

export const dynamic = 'force-dynamic';

/**
 * A photograph's bytes, fetched by the Next server and passed straight on.
 *
 * Every call to the API is made by the Next server rather than by the browser.
 * An `<img>` pointed at `NEXT_PUBLIC_API_URL` would render on this machine and
 * fail on the second device, which is the failure mode the README warns about
 * — and it would be the one request in the product going around whatever
 * ADR-0020 eventually puts in front of the API.
 *
 * The type is one of four images the API refuses to store otherwise, and the
 * browser is told not to look for a fifth.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Encoded, and not interpolated raw. Next decodes `%2F` and `%23` out of the
  // path before this sees them, so `..%2Fexposure%23` would arrive here as a
  // segment that walks up and out — turning this route into an open GET proxy
  // for every route on an API deliberately bound to loopback, in front of the
  // one thing on this host a second device can reach.
  const upstream = await apiFetch(
    `/photos/${encodeURIComponent(id)}/bytes`,
    { cache: 'no-store' },
  );

  if (!upstream.ok) {
    // A photograph that is not there is a 404 here too; anything else is the
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
