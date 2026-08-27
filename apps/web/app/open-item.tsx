import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { reopenOpenItem, resolveOpenItem } from './actions';
import type { OpenItem } from './api';

/** Just the day: the record keeps an instant, the screen does not need one. */
export function day(instant: string): string {
  return instant.slice(0, 10);
}

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
}: {
  item: OpenItem;
  projectId: string;
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
          <Badge variant="secondary">Resolved</Badge>
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
        <Field label="Open since" value={day(item.waitingSince)} />
        <Field label="Invalidated by" value={item.invalidationTrigger} />
        <Field label="Owner" value={item.owner} />
        {item.resolvedAt !== null && (
          <Field
            label="Resolved"
            value={`${day(item.resolvedAt)} — ${item.resolutionNote}`}
          />
        )}
      </dl>

      {resolved ? (
        <form action={reopenOpenItem.bind(null, projectId, item.id)}>
          <Button type="submit" variant="outline" size="sm">
            Reopen
          </Button>
        </form>
      ) : (
        <form
          action={resolveOpenItem.bind(null, projectId, item.id)}
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
