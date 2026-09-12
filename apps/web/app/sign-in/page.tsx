import { SignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

/**
 * The one screen in front of the gate (ADR-0055).
 *
 * It replaces `/unlock`, which asked for the deployment's one shared secret
 * and said in as many words that there was nobody to be. There is now: this
 * asks who you are, and the session it leaves behind is a row that can be
 * revoked on its own.
 *
 * The first account is made by a command on the machine (README says how) and
 * every one after that by somebody already signed in — so there is no sign-up
 * here, deliberately, and no "forgotten password" either: a reset over mail is
 * its own consent case and is deferred with a named trigger (ADR-0055).
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="max-w-sm space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground text-sm">
          This deployment holds real client work. Sign in as yourself; this
          browser will keep you signed in.
        </p>
      </div>
      <SignInForm next={next ?? '/'} />
    </div>
  );
}
