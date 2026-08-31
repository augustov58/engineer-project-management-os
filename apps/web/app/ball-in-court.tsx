import { Badge } from '@/components/ui/badge';
import type { BallInCourt, RegisterEntry } from './api';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Elapsed in-court time as whole days, which is the unit a turnaround is
 * written in. Floored, because a fourteen-day target is not breached by
 * fourteen days and an hour rounding up to fifteen.
 */
export function inCourtDays(inCourtMs: number): number {
  return Math.floor(inCourtMs / DAY);
}

/**
 * Whose move it is, everywhere an entry appears.
 *
 * `null` is unreachable — an entry is created with its first handoff in the
 * same transaction and nothing deletes one — but the wire type admits it, and
 * a badge has to render something rather than nothing.
 *
 * Read off the last handoff and never off a column: the badge and the history
 * below it are the same fact, so a screen cannot show one thing while the
 * record says another — which is the whole reason ball-in-court is a history.
 *
 * Ours is the state that costs us, so it is the one that stands out.
 */
export function BallInCourtBadge({
  ballInCourt,
}: {
  ballInCourt: BallInCourt | null;
}) {
  if (ballInCourt === null) {
    return <Badge variant="outline">Unheld</Badge>;
  }

  // Always the party's name, never "Our court" in its place: whether the ball
  // is ours is the stored boolean and not a reading of the name, so a job that
  // calls us by the firm's name must still show that name while reading as
  // ours. The variant carries the second fact.
  return (
    <Badge variant={ballInCourt.inOurCourt ? 'destructive' : 'secondary'}>
      {ballInCourt.party}
      {ballInCourt.inOurCourt && ' \u00b7 our court'}
    </Badge>
  );
}

/**
 * How long it has been ours, against the number it is measured by (story 73).
 *
 * Nothing at all where no target has been set: an entry with no contractual
 * number is not past anything, and a badge saying so would be inventing the
 * comparison story 73 exists to remove.
 *
 * `pastClock` comes off the record rather than being recomputed here, so this
 * badge and the clock screen cannot disagree about the same entry.
 */
export function ClockBadge({ entry }: { entry: RegisterEntry }) {
  if (entry.turnaroundDays === null) {
    return null;
  }

  return (
    <Badge
      variant={entry.pastClock ? 'destructive' : 'outline'}
      className="tabular-nums"
    >
      {inCourtDays(entry.inCourtMs)} / {entry.turnaroundDays} days
      {/*
        The word and not only the colour. Elapsed floors to whole days, so an
        entry a minute past a fourteen-day target reads "14 / 14" — the exact
        case the record says is past it, stated by two numbers that look equal.
      */}
      {entry.pastClock && ' · over'}
    </Badge>
  );
}
