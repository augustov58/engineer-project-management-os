import { apiFetch } from '../../../api';

export const dynamic = 'force-dynamic';

/**
 * The bytes of one file that arrived from outside, fetched by the Next server
 * and passed straight on (issue #19).
 *
 * The API answers `application/octet-stream` whatever the sender claimed the
 * type was, and those headers are carried through rather than replaced: a
 * stored `text/html` served under this origin is the hole ADR-0039 closed with
 * a closed set of three, and untrusted input closes it here instead. Nothing
 * below reads `upstream`'s content type for that reason.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Encoded, and not interpolated raw. Next decodes `%2F` and `%23` out of the
  // path before this sees them, so `..%2Fexposure%23` would arrive here as a
  // segment that walks up and out — turning this route into an open GET proxy
  // for every route on an API deliberately bound to loopback.
  const upstream = await apiFetch(
    `/ingested-document-files/${encodeURIComponent(id)}/bytes`,
    { cache: 'no-store' },
  );

  if (!upstream.ok) {
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition':
        upstream.headers.get('content-disposition') ?? 'attachment',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
