/**
 * The system's source of "now", injectable at the API boundary and defaulting
 * to the real clock.
 *
 * Named `TimeSource` rather than `Clock` on purpose: "clock" is already domain
 * vocabulary in this product — the aging of register entries sitting in our
 * court (ADR-0016, glossary "clock") — and a wall-clock abstraction must not
 * be confused with it.
 */
export interface TimeSource {
  now(): Date;
}

export const systemTimeSource: TimeSource = {
  now: () => new Date(),
};
