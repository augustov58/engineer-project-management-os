'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * A list of something slow, kept live over server-sent events.
 *
 * Written for the recordings on a walk (issue #12), reached for a second time
 * by its reports (issue #13) and a third by a project's memory runs and
 * proposals (issue #18) — the same trigger that moved the API's side of this
 * into the `stream.ts` leaf (ADR-0033, ADR-0035). The payload is whatever the
 * record's stream pushes: a list for the first two, both lists together for
 * the third. Two things it does are subtle enough that a second copy would be
 * a second place to get them wrong:
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
 * payload: every event carries the whole of it, so without a summary a
 * refresh would fire on every poll that changed nothing anybody can see.
 */
export function useLiveList<T>(
  path: string,
  initial: T,
  summarise: (current: T) => string,
): T {
  const [live, setLive] = useState(initial);
  const router = useRouter();
  const rendered = useRef(summarise(initial));

  useEffect(() => {
    // Nothing to open yet. The empty path is the one value read as *no
    // stream*, for the project chat's panel, which is on the page before a
    // conversation exists to stream (issue #121) — `new EventSource('')`
    // resolves to the page's own URL and would poll the document forever.
    if (path === '') {
      return;
    }
    const source = new EventSource(path);
    source.onmessage = (event) => {
      const current = JSON.parse(event.data as string) as T;
      setLive(current);

      const now = summarise(current);
      if (now !== rendered.current) {
        rendered.current = now;
        router.refresh();
      }
    };
    return () => source.close();
    // `summarise` is deliberately not a dependency: a new value on every
    // render would reopen the stream each time. It was a module-level
    // function at both call sites when that was written; `ExtractionWatch`
    // (issue #108) is a third, and passes an **inline** one, because what it
    // summarises is one row's state and the row's id is a prop. That is safe
    // for the same reason it is not a dependency — the effect captures this
    // function once, at mount, and never reads it again — and it is the
    // reason to be careful with it: anything the closure reads is frozen at
    // the value it had then. `ExtractionWatch`'s fallback is, and the seed it
    // is the fallback for is read once too.
  }, [path, router]);

  return live;
}
