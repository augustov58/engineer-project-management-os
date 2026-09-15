/** A project's own phases, their order, and which one it is in (issue #5). */

import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  NOT_BLANK,
  type RouteDependencies,
  isUniqueViolation,
} from '../http.js';
import {
  noSuchPhase,
  noSuchProject,
  phaseRefusal,
  refuse,
} from '../refusals.js';
import { projectOnTheWire } from '../wire.js';
import { audit } from '../audit.js';
import { actorOf } from '../gate.js';

/**
 * A phase is per-project free text — "50% CD", "90% CD", "Building Permit
 * Set" (ADR-0015). The cap matches a party name: these are labels an engineer
 * says out loud, not prose.
 */
const phaseBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', pattern: NOT_BLANK, maxLength: 120 } },
} as const;

/**
 * Reordering submits the whole ordered list rather than one move. It is then
 * atomic and idempotent, and there is no off-by-one to get wrong in a
 * `{ phase, toIndex }` call (ADR-0026).
 */
const phaseOrderBodySchema = {
  type: 'object',
  required: ['phaseIds'],
  additionalProperties: false,
  properties: { phaseIds: { type: 'array', items: { type: 'string' } } },
} as const;

const currentPhaseBodySchema = {
  type: 'object',
  required: ['phaseId'],
  additionalProperties: false,
  properties: { phaseId: { type: 'string' } },
} as const;

/**
 * Hold this project's phase order for the rest of the transaction (issue
 * #112, ADR-0055 part 5).
 *
 * ADR-0026 named this race and left it: "a phase's `position` is computed by
 * counting the existing rows before the insert, outside a transaction. Two
 * concurrent creates would collide; this is a single-user tool." The tool is
 * not one any more, so the collision is a defect — and it is the identical
 * count-then-insert shape `routes/ingest.ts` already locks for, where the
 * comment says why: counting and then inserting is two statements, so without
 * this every caller arriving in the same instant reads the same count and
 * every one of them passes.
 *
 * Both writers of `position` take it, which is what makes the create and the
 * reorder serialise against *each other* rather than only against themselves.
 * A lock per project, so one job's phases cannot delay another's.
 *
 * Not a `@@unique([projectId, position])` instead: a non-deferrable one would
 * reject the reorder mid-flight, since the positions are rewritten a row at a
 * time and a swap passes through a duplicate; and a deferrable one is a
 * constraint Prisma cannot express, so `schema.prisma` and the database would
 * disagree about what exists. The lock leaves both callers succeeding, where
 * a constraint would leave the second one failing.
 *
 * The key is prefixed where `ingest.ts`'s is the bare project id, so the two
 * are different locks: they guard different things on the same job, and a
 * phase waiting behind a piece of inbound mail would be a coupling nobody
 * asked for.
 */
function lockPhases(tx: Prisma.TransactionClient, projectId: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`phase-order:${projectId}`}))`;
}

export function phaseRoutes(
  v1: FastifyInstance,
  { prisma, timeSource, ingestDomain }: RouteDependencies,
): void {
  /**
   * Phases are rows on a project, never an enum: some jobs run 50% CD and
   * others go straight to 90% CD, so there is no set to share across them
   * (ADR-0015). A new one lands at the end of the list.
   */
  v1.post<{ Params: { id: string }; Body: { name: string } }>(
    '/projects/:id/phases',
    { schema: { body: phaseBodySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const at = timeSource.now();
      try {
        const phase = await prisma.$transaction(async (tx) => {
          await lockPhases(tx, project.id);
          const position = await tx.projectPhase.count({
            where: { projectId: project.id },
          });
          const created = await tx.projectPhase.create({
            data: { projectId: project.id, name: request.body.name, position },
          });
          await audit(tx, {
            projectId: project.id,
            actor: actorOf(request),
            subject: { type: 'phase', id: created.id },
            action: 'phase added',
            detail: `${created.name}, at position ${created.position}`,
            at,
          });
          return created;
        });
        return reply.code(201).send(phase);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that phase name is already on this project' });
        }
        throw error;
      }
    },
  );

  v1.get<{ Params: { id: string } }>(
    '/projects/:id/phases',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      return prisma.projectPhase.findMany({
        where: { projectId: project.id },
        orderBy: { position: 'asc' },
      });
    },
  );

  /**
   * Renaming propagates to every submission issued at this phase, because
   * a rename is the same body of work under a better name. A set that
   * went out at a different stage is a different phase (ADR-0026).
   */
  v1.post<{ Params: { id: string }; Body: { name: string } }>(
    '/phases/:id/rename',
    { schema: { body: phaseBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const phase = await prisma.projectPhase.findUnique({ where: { id } });
      if (phase === null) {
        return noSuchPhase(reply);
      }

      const at = timeSource.now();
      try {
        return await prisma.$transaction(async (tx) => {
          const renamed = await tx.projectPhase.update({
            where: { id },
            data: { name: request.body.name },
          });
          // Both names, because a rename propagates to every submission
          // issued at this phase (ADR-0026) and the old one is not kept
          // anywhere else.
          await audit(tx, {
            projectId: phase.projectId,
            actor: actorOf(request),
            subject: { type: 'phase', id: renamed.id },
            action: 'phase renamed',
            detail: `${phase.name} is now ${renamed.name}`,
            at,
          });
          return renamed;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that phase name is already on this project' });
        }
        throw error;
      }
    },
  );

  /**
   * The whole ordered list, or nothing. A partial list would silently
   * leave a phase at a stale position and a repeated id would give two
   * phases the same place, so both are refused rather than absorbed.
   */
  v1.post<{ Params: { id: string }; Body: { phaseIds: string[] } }>(
    '/projects/:id/phases/order',
    { schema: { body: phaseOrderBodySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const { phaseIds } = request.body;
      const at = timeSource.now();
      const refusal = await prisma.$transaction(async (tx) => {
        // Before the set is read, not after it: the list a caller submits is
        // checked against the phases there are, and a phase added between the
        // check and the writes would be left at a position the order it was
        // just measured against does not mention.
        await lockPhases(tx, project.id);

        const existing = await tx.projectPhase.findMany({
          where: { projectId: project.id },
          select: { id: true, name: true },
        });
        const known = new Set(existing.map((phase) => phase.id));
        const named = new Set(phaseIds);
        if (
          named.size !== phaseIds.length ||
          named.size !== known.size ||
          phaseIds.some((phaseId) => !known.has(phaseId))
        ) {
          return "an order must name exactly this project's phases, once each";
        }

        const nameOf = new Map(existing.map((phase) => [phase.id, phase.name]));
        for (const [position, phaseId] of phaseIds.entries()) {
          await tx.projectPhase.update({
            where: { id: phaseId },
            data: { position },
          });
        }
        // The order and not the moves: the whole list is what was submitted
        // (ADR-0026), so the whole list is what the line says.
        await audit(tx, {
          projectId: project.id,
          actor: actorOf(request),
          subject: { type: 'project', id: project.id },
          action: 'phases reordered',
          detail: phaseIds.map((phaseId) => nameOf.get(phaseId)).join(', '),
          at,
        });
        return null;
      });

      if (refusal !== null) {
        return reply.code(409).send({ message: refusal });
      }

      return prisma.projectPhase.findMany({
        where: { projectId: project.id },
        orderBy: { position: 'asc' },
      });
    },
  );

  /**
   * The first route that updates a project. The project *number* is what
   * the glossary makes immutable, and it still is — this writes the phase
   * a new submission defaults to (ADR-0026).
   */
  v1.post<{ Params: { id: string }; Body: { phaseId: string } }>(
    '/projects/:id/current-phase',
    { schema: { body: currentPhaseBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const badPhase = await phaseRefusal(
        prisma,
        request.body.phaseId,
        project.id,
      );
      if (badPhase !== null) {
        return refuse(reply, badPhase);
      }

      const at = timeSource.now();
      const phase = await prisma.projectPhase.findUniqueOrThrow({
        where: { id: request.body.phaseId },
        select: { name: true },
      });
      return projectOnTheWire(
        await prisma.$transaction(async (tx) => {
          const updated = await tx.project.update({
            where: { id },
            data: { currentPhaseId: request.body.phaseId },
          });
          await audit(tx, {
            projectId: id,
            actor: actorOf(request),
            subject: { type: 'project', id: updated.id },
            action: 'current phase set',
            detail: phase.name,
            at,
          });
          return updated;
        }),
        ingestDomain,
      );
    },
  );

}
