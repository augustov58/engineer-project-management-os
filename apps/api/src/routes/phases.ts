/** A project's own phases, their order, and which one it is in (issue #5). */

import type { FastifyInstance } from 'fastify';
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
        const position = await prisma.projectPhase.count({
          where: { projectId: project.id },
        });
        const phase = await prisma.$transaction(async (tx) => {
          const created = await tx.projectPhase.create({
            data: { projectId: project.id, name: request.body.name, position },
          });
          await audit(tx, {
            projectId: project.id,
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
      const existing = await prisma.projectPhase.findMany({
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
        return reply.code(409).send({
          message: "an order must name exactly this project's phases, once each",
        });
      }

      const at = timeSource.now();
      const nameOf = new Map(existing.map((phase) => [phase.id, phase.name]));
      await prisma.$transaction(async (tx) => {
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
          action: 'phases reordered',
          detail: phaseIds.map((phaseId) => nameOf.get(phaseId)).join(', '),
          at,
        });
      });

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
