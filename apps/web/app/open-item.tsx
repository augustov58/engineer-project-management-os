import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { handOnOpenItem, reopenOpenItem, resolveOpenItem } from './actions';
import type { OpenItem, User } from './api';
import { selectClassName } from './native-select';
import { clock, day } from './wall-clock';

function Field({ label, value }: { label: string; value: string | null }) {
  return value === null ? null : (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/**
 * One open item on the project it is attached to. Resolved items render the
 * same way plus their resolution, because a resolved item stays visible here.
 */
export function OpenItemEntry({
  item,
  projectId,
  detach,
  restedOnAtIssuance = false,
  raisedFromFlag = false,
  users,
  timeZone,
  keepAt = null,
  kept = false,
}: {
  item: OpenItem;
  projectId: string;
  /**
   * Everyone at the firm, so the item can be handed on (issue #112,
   * ADR-0055 part 5). An item sits with whoever raised it and is changeable;
   * that is what *mine* means on the pending items view.
   */
  users: User[];
  /**
   * Present only where the item is being shown as something an issuance
   * rests on. The button lives inside the entry rather than beside it
   * because this component owns the `<li>`, and a second one around it is
   * invalid HTML that hydration rejects.
   */
  detach?: () => Promise<void>;
  /**
   * That this item was named when the set went out, rather than attached
   * afterwards. Such an item has no detach button, and saying so is why:
   * removing it would erase the record of what was issued (ADR-0026).
   */
  restedOnAtIssuance?: boolean;
  /**
   * That this item was raised from a `FLAGS / VERIFY` entry on this
   * submission (issue #8). It has no detach button either: it was never
   * attached by hand, so it cannot be on the wrong set, and dropping it is
   * the flag being raised and then forgotten.
   */
  raisedFromFlag?: boolean;
  /** The zone of the job this record is on (ADR-0054). */
  timeZone: string;
  /**
   * Where resolving this one should land so that it **keeps its place** (issue
   * #120, density rule 4). Only the project record passes it, because it is
   * the only screen that files a resolved item somewhere else.
   */
  keepAt?: string | null;
  /**
   * That this is the row that just resolved, shown in place rather than filed
   * under *Resolved* (issue #120, density rule 4). It carries the word for
   * what happened and the undo, which is what the plate draws.
   */
  kept?: boolean;
}) {
  const resolved = item.resolvedAt !== null;

  return (
    <li
      className={`rounded-lg border p-4 ${resolved ? 'bg-muted/30' : ''} space-y-3`}
    >
      <div className="flex items-start justify-between gap-4">
        <p className={`font-medium ${resolved ? 'text-muted-foreground' : ''}`}>
          {item.unresolved}
        </p>
        {resolved ? (
          <Badge variant="secondary">
            {kept ? 'Resolved just now' : 'Resolved'}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0">
            {item.waitingOn ?? 'Nobody'}
          </Badge>
        )}
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
        <Field label="Blocks" value={item.blocks} />
        <Field label="If wrong" value={item.counterfactual} />
        {resolved && (
          <Field label="Next move" value={item.waitingOn ?? 'Nobody'} />
        )}
        <Field label="Open since" value={day(item.waitingSince, timeZone)} />
        <Field label="Invalidated by" value={item.invalidationTrigger} />
        {/*
          Whose it is on our side of the line, where **next move** above is the
          party's (issue #112). A user since ADR-0055 part 5, so it is a name
          and never a blank.
        */}
        {/*
          Not a `Field` like the rest: the owner is the one thing about an
          item that changes outside resolving it, so the row it is read on is
          also the row it is handed on from.

          Native, for the reason every other select here is (ADR-0025): the
          action reads this out of `FormData`.
        */}
        <dt className="text-muted-foreground">Owner</dt>
        <dd>
          <form
            action={handOnOpenItem.bind(null, projectId, item.id)}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor={`owner-${item.id}`} className="sr-only">
              Who it sits with
            </label>
            <select
              id={`owner-${item.id}`}
              name="ownerId"
              defaultValue={item.owner.id}
              className={selectClassName}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="ghost" size="sm">
              Hand it on
            </Button>
          </form>
        </dd>
        {item.resolvedAt !== null && (
          <Field
            label="Resolved"
            value={`${day(item.resolvedAt, timeZone)} — ${item.resolutionNote}`}
          />
        )}
      </dl>

      {resolved ? (
        <form
          action={reopenOpenItem.bind(null, projectId, item.id)}
          className="flex flex-wrap items-center gap-3"
        >
          <Button type="submit" variant="outline" size="sm">
            {/*
              The undo beside the row it undoes (density rule 4). *Reopen*
              everywhere else, because everywhere else it is a considered act
              on an item filed days ago; here it is the mis-click being taken
              back, and the baseline recorded that one as *hunting*.
            */}
            {kept ? 'Undo' : 'Reopen'}
          </Button>
          {kept && (
            <span className="text-muted-foreground text-xs">
              It stays here until the next load &mdash; it does not jump to
              Resolved under your cursor.
            </span>
          )}
        </form>
      ) : (
        <form
          action={resolveOpenItem.bind(null, projectId, item.id, keepAt)}
          className="flex flex-wrap items-center gap-2 border-t pt-3"
        >
          <Input
            name="note"
            required
            placeholder="How it resolved"
            className="min-w-48 flex-1"
          />
          <Input
            name="resolvedAt"
            type="date"
            title="When it was answered"
            className="w-40"
          />
          <Button type="submit" variant="secondary">
            Resolve
          </Button>
        </form>
      )}

      {restedOnAtIssuance && (
        <p className="text-muted-foreground text-right text-sm">
          Named when the set went out — part of the record, not removable.
        </p>
      )}

      {raisedFromFlag && (
        <p className="text-muted-foreground text-right text-sm">
          Raised from a flag on this submission — not removable. Answer it with
          a resolution note instead.
        </p>
      )}

      {detach !== undefined && (
        <form action={detach} className="flex justify-end">
          <Button type="submit" variant="ghost" size="sm">
            Not part of this submission
          </Button>
        </form>
      )}
    </li>
  );
}
