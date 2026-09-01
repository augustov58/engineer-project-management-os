'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { EDGE_COOKIE, edgeSecret, unlocked } from '../edge-secret';

/** A year. The secret is long-lived, and rotating it is a redeploy. */
const A_YEAR = 60 * 60 * 24 * 365;

/**
 * Where to go once it is presented.
 *
 * Only a path on this deployment. `//elsewhere.example` is a URL a browser
 * reads as another origin, so anything that is not a single leading slash is
 * refused and the morning screen is used instead — otherwise the one page an
 * anonymous caller can reach would be a redirector to anywhere.
 */
function destination(next: FormDataEntryValue | null): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) {
    return '/';
  }
  return next;
}

export async function unlock(
  _previous: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const presented = formData.get('secret');

  if (typeof presented !== 'string' || !unlocked(presented)) {
    // One sentence for a wrong secret and for none at all: there is nothing
    // here to tell apart, and a longer answer would only describe the shape
    // of the thing being guessed.
    return 'That is not the secret for this deployment.';
  }

  const store = await cookies();
  store.set(EDGE_COOKIE, edgeSecret(), {
    httpOnly: true,
    sameSite: 'lax',
    // Over plain HTTP a secure cookie is never sent back, and local
    // development has no TLS. A deployment is behind TLS (ADR-0003), which is
    // where this matters and where `NODE_ENV` is production.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: A_YEAR,
  });

  redirect(destination(formData.get('next')));
}
