'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSession, revokeSession } from '../api';
import { destination } from './destination';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '../session';

/**
 * One sentence for a wrong password, an address with nobody behind it and a
 * disabled user alike: there is nothing here to tell apart, and a longer
 * answer would only describe the shape of the thing being guessed. It is the
 * API's own sentence, said again rather than invented — the copy across the
 * wire is deliberate, and having it twice on this side is not.
 */
const NOT_AN_ACCOUNT = 'That is not an account here, or not its password.';

export async function signIn(
  _previous: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const email = formData.get('email');
  const password = formData.get('password');

  if (typeof email !== 'string' || typeof password !== 'string') {
    return NOT_AN_ACCOUNT;
  }

  const session = await createSession(email, password);
  if (session === undefined) {
    return NOT_AN_ACCOUNT;
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, session, SESSION_COOKIE_OPTIONS);

  redirect(destination(formData.get('next')));
}

/**
 * Sign out: revoke the row, then stop sending the cookie.
 *
 * In that order, and both: revoking without clearing leaves a browser holding
 * a credential it will present until it expires, and clearing without revoking
 * leaves the row live for anything that copied the value. The redirect is to
 * the sign-in screen rather than to `/`, so the answer is the screen the
 * engineer asked for and not a bounce through the gate.
 *
 * The revoke **answers** a refusal rather than redirecting on one, so that
 * signing out of a session that is already dead still clears the cookie: a
 * redirect thrown here would skip the line below and leave the browser holding
 * a credential it will present on every page until it next signs in.
 */
export async function signOut(): Promise<void> {
  await revokeSession();
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect('/sign-in');
}
