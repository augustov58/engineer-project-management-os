/**
 * A browser-side instant, written the way a typed time is.
 *
 * A floor started at 13:00 typed into the schedule is stored as `13:00Z`
 * whatever zone it was typed in — `composeInstant` in `actions.ts` does that.
 * ADR-0030 left the product-wide timezone decision open deliberately and noted
 * that the screens are written so a walk stays in one frame. Sending a true
 * UTC instant would put a photograph or a recording in the other one, and by
 * the engineer's offset every photograph of the afternoon would bin to nothing
 * and every observation would be dated an hour out.
 *
 * So the local wall clock goes up as though it were UTC. When the product
 * takes the timezone decision, this and `composeInstant` change together.
 *
 * Shared, because two screens now read a clock the browser owns: the moment a
 * photograph was last modified (ADR-0032) and the moment a recording was made.
 */
export function asTypedInstant(epochMilliseconds: number): string {
  const local = new Date(epochMilliseconds);
  const offset = local.getTimezoneOffset() * 60_000;
  return new Date(epochMilliseconds - offset).toISOString();
}
