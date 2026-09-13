/**
 * The helper route: one route, driven by the manifests (issue #107, ADR-0053
 * and its correction of 2026-09-11).
 *
 * `POST /v1/tools/:name` is the surface a helper skill reaches the product
 * through — not an SDK tool inside the agent's own process, which is the shape
 * ADR-0041 closed and this route exists to keep closed. The vendor's path
 * resolver is never in the path; the boundary is a route of ours, where every
 * other refusal in this product lives.
 *
 * A file under `routes/` without being a record type, which is the one place
 * ADR-0033's rule is stretched rather than followed: there is no `tools` record
 * and there is no `tools` table. It is still a route module — a plain function
 * called from the one `register` in `server.ts`, importing no other route module
 * — and `test/tools.test.ts` is the test file ADR-0033 pairs it with.
 *
 * **It records nothing.** No row, no audit line, no stamp. Asking a helper and
 * recording what it said are two acts: recording is still confirming an
 * assumption record against a submission (ADR-0029), and this route is the
 * asking. That is why it is the one mutating-method route `test/audit.test.ts`
 * exempts, and why it answers 200 rather than 201.
 */

import type { FastifyInstance } from 'fastify';
import {
  argumentProblem,
  helper,
  registry,
  runHelper,
  type HelperRun,
} from '../helpers.js';
import type { RouteDependencies } from '../http.js';

/**
 * The one 404 body, matching the `noSuch…` set in `refusals.ts` in shape but
 * staying here: one record reaches for it, and a thing used by exactly one
 * record lives with that record (ADR-0033).
 */
const NO_SUCH_HELPER = 'no helper with that name';

/**
 * And the sentence for when there are no helpers at all.
 *
 * An empty `apps/api/tools/` is a deployment whose submodule was never checked
 * out, and every name would otherwise be answered *wrong name* — which sends
 * whoever is reading it looking for a typo. CI cannot catch this one: ADR-0052
 * deliberately does not deploy, so a `fly deploy` from a tree without
 * `git submodule update --init` is exactly the state this names.
 */
const NO_HELPERS_INSTALLED =
  'this deployment has no helper skills installed: apps/api/tools is empty';

/**
 * A body has to be an object before a manifest's schema can be asked about it.
 * The real validation is the named helper's own schema, which is data and so
 * cannot be a route schema: there is one route and a schema per helper.
 */
const argumentsSchema = { type: 'object' } as const;

/** What the caller gets back when a helper ran. */
const STATUS: Record<Exclude<HelperRun['outcome'], 'ran'>, number> = {
  // The arguments were this helper's to refuse, and it did.
  refused: 400,
  // It is still running; nothing is known about what it would have said.
  'timed out': 504,
  // A fact about this deployment and not about the request.
  'cannot run': 503,
  // It answered, and the answer is not a record.
  broken: 502,
};

export function toolRoutes(
  v1: FastifyInstance,
  _dependencies: RouteDependencies,
): void {
  v1.post<{ Params: { name: string }; Body: Record<string, unknown> }>(
    '/tools/:name',
    { schema: { body: argumentsSchema } },
    async (request, reply) => {
      if (registry().helpers.length === 0) {
        return reply.code(503).send({ message: NO_HELPERS_INSTALLED });
      }

      const found = helper(request.params.name);
      if (found === undefined) {
        return reply.code(404).send({ message: NO_SUCH_HELPER });
      }

      const problem = argumentProblem(found, request.body);
      if (problem !== null) {
        return reply.code(400).send({ message: problem });
      }

      const result = await runHelper(found, request.body);
      if (result.outcome !== 'ran') {
        return reply
          .code(STATUS[result.outcome])
          .send({ message: result.message });
      }

      // Verbatim, and split into the two the record is made of. Nothing is
      // trimmed, normalised or re-wrapped on the way out (ADR-0029), and
      // `output` is the whole report the blocks were printed inside.
      return reply.code(200).send({
        helper: found.manifest.name,
        assumptions: result.assumptions,
        flags: result.flags,
        output: result.output,
      });
    },
  );
}
