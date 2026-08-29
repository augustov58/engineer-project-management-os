'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * A walk's list of something slow, kept live over server-sent events.
 *
 * Written for the recordings on a walk (issue #12) and reached for a second
 * time by its reports (issue #13) — the same trigger that moved the API's
 * side of this into the `stream.ts` leaf (ADR-0033, ADR-0035). Both of the
 * things it does are subtle enough that a second copy would be a second place
 * to get them wrong:
 *
 * **The state is seeded from a prop and corrected by the stream afterwards,
 * never the other way round.** A value set from an effect or a ref during the
 * hydration commit is discarded (ADR-0028), so anything the first paint must
 * show has to arrive as a prop — which is why `initial` is not an initial
 * *fetch*.
 *
 * **A change the page renders differently asks the server for the page
 * again.** The forms below these lists are server-rendered and their actions
 * are bound to ids only the server knows, so the client cannot render the new
 * state itself. `summarise` is what "renders differently" means for a given
 * list: every event carries the whole list, so without it a refresh would fire
 * on every poll that changed nothing anybody can see.
 */
export function useLiveList<T>(
  path: string,
  initial: T[],
  summarise: (rows: T[]) => string,
): T[] {
  const [live, setLive] = useState(initial);
  const router = useRouter();
  const rendered = useRef(summarise(initial));

  useEffect(() => {
    const source = new EventSource(path);
    source.onmessage = (event) => {
      const rows = JSON.parse(event.data as string) as T[];
      setLive(rows);

      const now = summarise(rows);
      if (now !== rendered.current) {
        rendered.current = now;
        router.refresh();
      }
    };
    return () => source.close();
    // `summarise` is a module-level function at both call sites and is
    // deliberately not a dependency: an inline one would be a new value on
    // every render and would reopen the stream each time.
  }, [path, router]);

  return live;
}
