/**
 * Reading a required environment variable, and failing at startup rather than
 * at the first call that needed it.
 *
 * A leaf by ADR-0033's trigger and not before it: this was nine lines inside
 * `index.ts` and stayed there while `DATABASE_URL`, `REDIS_URL` and
 * `OBJECT_STORE_DIR` were its only readers. Issue #109 gave it two more — the
 * OCR adapter's endpoint and key, and the transcription adapter's — and a
 * vendor adapter cannot reach into the composition root without a cycle, since
 * the composition root is what builds it. Three readers, so it moves; the
 * function is unchanged.
 *
 * Called while `index.ts` is still wiring, so an adapter selected without its
 * credential takes the process down before the server listens. That is the
 * point: a deployment that names a vendor and forgets its key must not boot
 * and then fail one record at a time.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Copy apps/api/.env.example to apps/api/.env.`,
    );
  }
  return value;
}
