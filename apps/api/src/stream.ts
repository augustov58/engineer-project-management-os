/**
 * Progress over server-sent events: one stream, pushing a whole list whenever
 * it changes.
 *
 * A leaf, and here rather than beside a record because two of them reach for
 * it (ADR-0033). It was written for a walk's recordings (issue #12) and is
 * reached for a second time by a walk's reports (issue #13) — the trigger that
 * ADR names for moving a thing out of the record it started in. Every comment
 * below is the reason it is shaped the way it is, and each of them was a bug
 * before it was a comment.
 *
 * SSE and not WebSocket, which ADR-0034 settled: one direction, one kind of
 * fact, nothing for the browser to say back, and no Fastify plugin — which
 * keeps ADR-0023's single `register` call the only place a prefix can be
 * added.
 *
 * What moves is the **state**, never a percentage (ADR-0034). This module
 * pushes whatever the reader it is given returns, and the reader returns rows.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * How often a stream looks for a change.
 *
 * A poll behind a push, and deliberately: the state lives in PostgreSQL, and a
 * second transport carrying the same fact — Redis pub/sub, or BullMQ's own
 * events — would be a second thing that can be right when the row is wrong.
 * What the browser gets is still a push, which is what the criterion asks for.
 * Half a second is under the threshold at which a screen reads as live and far
 * above the cost of one indexed query for one walk.
 */
const POLL_MS = 500;

/** So a proxy between here and the phone does not time the stream out. */
const HEARTBEAT_MS = 15_000;

/**
 * The opener for one record's streams, and the shutdown hook that ends them.
 *
 * Called once per record module, so that closing the server ends what that
 * record has open. The hook holds the **stop functions** and not the replies:
 * ending the socket is only half of it, and a hook that did only that would
 * leave a stream's timers running against a response that had ended — where
 * the heartbeat's write raises `'error'` on a `ServerResponse` nobody is
 * listening to, which takes the process down.
 */
export function progressStreams(v1: FastifyInstance) {
  const streaming = new Set<() => void>();

  // `preClose` and not `onClose`: Fastify closes the HTTP server between the
  // two, and a hijacked event-stream socket is not idle — so an `onClose` hook
  // would be waiting to end the very streams the server was waiting on.
  v1.addHook('preClose', async () => {
    for (const stop of [...streaming]) {
      stop();
    }
  });

  /**
   * Hijacks the reply and pushes what `read` answers, whenever it changes.
   *
   * Every event carries the whole list rather than a delta. A walk has a
   * handful of each of these, the client then needs no reducer and cannot
   * drift, and a reconnecting phone is correct on its first event rather than
   * after replaying what it missed.
   */
  return async function stream(
    request: FastifyRequest,
    reply: FastifyReply,
    read: () => Promise<unknown>,
  ): Promise<void> {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Nginx and friends buffer a response body by default, which turns a
      // live stream into one silent block at the end.
      'x-accel-buffering': 'no',
    });

    /**
     * Nothing is written to a response that has ended.
     *
     * Both writers go through here: the heartbeat fires on a timer of its own
     * and is not inside the chain the poll's `catch` guards, so without this a
     * stream stopped between two beats would write once more.
     */
    const write = (chunk: string): void => {
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        return;
      }
      reply.raw.write(chunk);
    };

    let last = '';
    // One read at a time. The interval does not await, so a query slower than
    // the tick would otherwise let two reads finish out of order and leave
    // `last` holding the older of them.
    let reading = false;
    const push = async () => {
      if (reading) {
        return;
      }
      reading = true;
      try {
        const payload = JSON.stringify(await read());
        if (payload !== last) {
          last = payload;
          write(`data: ${payload}\n\n`);
        }
      } finally {
        reading = false;
      }
    };

    // The first event is the state right now, so a screen that opens on
    // finished work is not left waiting for a change that has already
    // happened.
    await push();

    const poll = setInterval(() => {
      void push().catch(() => {
        // The database went away or the socket did. Either way this stream has
        // nothing further to say, and the client reconnects.
        stop();
      });
    }, POLL_MS);
    const beat = setInterval(() => {
      write(': still here\n\n');
    }, HEARTBEAT_MS);
    // Neither timer is a reason for the process to stay up.
    poll.unref();
    beat.unref();

    let stopped = false;
    function stop() {
      // Idempotent: the client closing and the server shutting down can both
      // reach here, and in either order.
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(poll);
      clearInterval(beat);
      streaming.delete(stop);
      reply.raw.end();
    }

    streaming.add(stop);
    request.raw.on('close', stop);
    // The first read is awaited above, so a client that gave up during it has
    // already fired `close` and would never fire it again.
    if (request.raw.destroyed) {
      stop();
    }
  };
}
