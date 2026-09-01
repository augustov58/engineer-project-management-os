import { UnlockForm } from './unlock-form';

export const dynamic = 'force-dynamic';

/**
 * The one screen in front of the gate (ADR-0020).
 *
 * Not a login: there is nobody to be. It asks for the deployment's one shared
 * secret, and the browser holds it from then on — so this is seen once per
 * device and again only after the secret is rotated, which is a redeploy.
 */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="max-w-lg space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Locked</h1>
        <p className="text-muted-foreground text-sm">
          This deployment holds real client work and has no accounts. Present
          the shared secret once and this browser will keep it.
        </p>
      </div>
      <UnlockForm next={next ?? '/'} />
    </div>
  );
}
