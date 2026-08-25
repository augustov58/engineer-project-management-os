import { reopenOpenItem, resolveOpenItem } from './actions';
import type { OpenItem } from './api';

/** Just the day: the record keeps an instant, the screen does not need one. */
export function day(instant: string): string {
  return instant.slice(0, 10);
}

function Field({ label, value }: { label: string; value: string | null }) {
  return value === null ? null : (
    <>
      <dt>{label}</dt>
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
}: {
  item: OpenItem;
  projectId: string;
}) {
  return (
    <li style={{ marginBottom: '1rem' }}>
      <strong>{item.unresolved}</strong>
      <dl style={{ margin: '0.25rem 0 0.25rem 1rem' }}>
        <Field label="Blocks" value={item.blocks} />
        <Field label="If wrong" value={item.counterfactual} />
        <dt>Next move</dt>
        <dd>{item.waitingOn ?? 'Nobody'}</dd>
        <dt>Since</dt>
        <dd>{day(item.waitingSince)}</dd>
        <Field label="Invalidated by" value={item.invalidationTrigger} />
        <Field label="Owner" value={item.owner} />
        {item.resolvedAt !== null && (
          <>
            <dt>Resolved</dt>
            <dd>
              {day(item.resolvedAt)} — {item.resolutionNote}
            </dd>
          </>
        )}
      </dl>

      {item.resolvedAt === null ? (
        <form action={resolveOpenItem.bind(null, projectId, item.id)}>
          <input name="note" required size={40} placeholder="How it resolved" />{' '}
          <button type="submit">Resolve</button>
        </form>
      ) : (
        <form action={reopenOpenItem.bind(null, projectId, item.id)}>
          <button type="submit">Reopen</button>
        </form>
      )}
    </li>
  );
}
