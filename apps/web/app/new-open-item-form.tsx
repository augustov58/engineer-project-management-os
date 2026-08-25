'use client';

import { useActionState, useState } from 'react';
import { createOpenItem } from './actions';

const row = { display: 'block', marginBottom: '0.5rem' } as const;

export function NewOpenItemForm({ projectId }: { projectId: string }) {
  const [error, action, pending] = useActionState(
    createOpenItem.bind(null, projectId),
    undefined,
  );
  // Nobody is a real answer, so it is a control of its own rather than the
  // absence of one. Ticking it takes the party field out of play entirely.
  const [nobody, setNobody] = useState(false);

  return (
    <form action={action}>
      <label style={row}>
        What is unresolved <br />
        <input name="unresolved" required size={60} />
      </label>

      <label style={row}>
        What it blocks <br />
        <input name="blocks" required size={60} />
      </label>

      <label style={row}>
        What changes if the assumption is wrong <br />
        <input name="counterfactual" required size={60} />
      </label>

      <label style={row}>
        Who owes the next move{' '}
        <input
          name="waitingOn"
          required={!nobody}
          disabled={nobody}
          size={24}
        />
      </label>

      <label style={row}>
        <input
          name="nobody"
          type="checkbox"
          checked={nobody}
          onChange={(event) => setNobody(event.target.checked)}
        />{' '}
        Nobody owes the next move
      </label>

      <label style={row}>
        Open since <input name="waitingSince" type="date" />{' '}
        <small>blank means today</small>
      </label>

      <label style={row}>
        Invalidation trigger <input name="invalidationTrigger" size={40} />{' '}
        <small>optional</small>
      </label>

      <label style={row}>
        Owner <input name="owner" size={16} /> <small>optional</small>
      </label>

      <button type="submit" disabled={pending}>
        Add open item
      </button>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}
