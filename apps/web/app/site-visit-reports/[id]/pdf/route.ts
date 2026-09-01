import { apiFetch } from '../../../api';

export const dynamic = 'force-dynamic';

/**
 * The report's PDF, fetched by the Next server and passed straight on.
 *
 * The same shape as a photograph's bytes and a recording's audio, and for the
 * same reason: every call to the API is made by this server, so the one thing
 * this product issues outside itself does not go around whatever ADR-0020
 * eventually puts in front of the API.
 *
 * `encodeURIComponent`, as those two do — ADR-0032 found that hole in the
 * photo route, and this is the same route written again.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upstream = await apiFetch(
    `/site-visit-reports/${encodeURIComponent(id)}/pdf`,
    { cache: 'no-store' },
  );

  if (!upstream.ok) {
    // A report that is not there is a 404 here too. A report that has not
    // rendered is the API's 409, and it is not this route's to reword: the
    // screen already knows the state and does not offer this link until there
    // is a document behind it.
    return new Response(null, {
      status: upstream.status === 404 || upstream.status === 409
        ? upstream.status
        : 502,
    });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      // Inline, so the link opens the document rather than downloading it.
      // The name is generic because this route knows an id and nothing else,
      // and a second call to the API to learn the project and the date is not
      // worth what it would buy.
      'content-disposition': 'inline; filename="site-visit-report.pdf"',
      'cache-control': 'no-store',
    },
  });
}
