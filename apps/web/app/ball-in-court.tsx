import { Badge } from '@/components/ui/badge';
import type { BallInCourt } from './api';

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
