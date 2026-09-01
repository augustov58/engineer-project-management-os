/** Project memory: the curated prose, its versions, proposals and runs (issue #18). */

import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  isUniqueViolation,
  NOT_BLANK,
  type RouteDependencies,
} from '../http.js';
import { noSuchProject } from '../refusals.js';
import { progressStreams } from '../stream.js';
import { PROPOSE_MEMORY_EDIT, type ProposeMemoryEditJob } from '../worker.js';

/**
 * The size budget, in characters (story 101).
 *
 * Memory is kept deliberately small so it stays readable rather than becoming
 * a dumping ground: about a page and a half of prose. The budget is
 * **surfaced**, not enforced — it rides on every memory read so the interface
 * can push back as the document fills, and nothing here refuses a write that
 * exceeds it, because the engineer's judgement about what is worth keeping is
 * the thing the budget exists to inform.
 */
export const MEMORY_BUDGET = 4_000;

/** The longest memory the boundary takes, budget or not. */
const CONTENT_MAX = 32_768;

const writeBodySchema = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: {
    content: { type: 'string', pattern: NOT_BLANK, maxLength: CONTENT_MAX },
  },
} as const;

const proposalBodySchema = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: {
    content: { type: 'string', pattern: NOT_BLANK, maxLength: CONTENT_MAX },
  },
} as const;

const acceptBodySchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    /**
     * Supplied, it is the text committed — the "edit" of accept, edit or
     * reject. Left off, the proposal's own text is committed verbatim. Null
     * is not admitted: omitting and nulling read alike on the wire but not in
     * the audit, and the audit is where the difference is a fact.
     */
    content: { type: 'string', pattern: NOT_BLANK, maxLength: CONTENT_MAX },
  },
} as const;

/** What a version is read as. Nothing is stripped; nothing is derived. */
const versionSelect = {
  id: true,
  projectId: true,
  content: true,
  proposalId: true,
  createdAt: true,
} satisfies Prisma.ProjectMemoryVersionSelect;

const runSelect = {
  id: true,
  projectId: true,
  runningSince: true,
  finishedAt: true,
  failedAt: true,
  failure: true,
  createdAt: true,
} satisfies Prisma.AgentRunSelect;

const proposalSelect = {
  id: true,
  projectId: true,
  runId: true,
  baseContent: true,
  proposed: true,
  createdAt: true,
  acceptedAt: true,
  rejectedAt: true,
} satisfies Prisma.MemoryProposalSelect;

type StoredRun = Prisma.AgentRunGetPayload<{ select: typeof runSelect }>;
type StoredProposal = Prisma.MemoryProposalGetPayload<{
  select: typeof proposalSelect;
}>;

/**
 * The run's state, derived on every read from the four stamps — queued is
 * all four null — with no status column beside them (ADR-0035's shape, for
 * the third queued record).
 */
function runOnTheWire(run: StoredRun) {
  const state =
    run.failedAt !== null
      ? 'failed'
      : run.finishedAt !== null
        ? 'finished'
        : run.runningSince !== null
          ? 'running'
          : 'queued';
  return { ...run, state };
}

/**
 * Pending is both stamps null; resolved is exactly one set.
 *
 * `stale` is derived beside the state and stored nowhere: the memory has
 * moved since this proposal's base was snapshotted, so the diff the review
 * screen draws no longer describes what accepting would commit, and the
 * accept route refuses (issue #42). Only a pending proposal can be stale —
 * a resolved one is a record of what happened, not an offer.
 */
function proposalOnTheWire(proposal: StoredProposal, current: string | null) {
  const state =
    proposal.acceptedAt !== null
      ? 'accepted'
      : proposal.rejectedAt !== null
        ? 'rejected'
        : 'pending';
  return {
    ...proposal,
    state,
    stale: state === 'pending' && proposal.baseContent !== current,
  };
}

/**
 * The order a project's memory reads in, oldest first — and a **total** one.
 *
 * `created_at` is `TIMESTAMP(3)`, so two versions written in the same
 * millisecond tie, and the `id` this used to fall back on is a random v4
 * uuid: the tie was settled by coin toss, and the older of the two could
 * read as the current memory. `seq` is a sequence, allocated in the order
 * the inserts were issued (issue #42).
 */
const OLDEST_FIRST = [
  { createdAt: 'asc' },
  { seq: 'asc' },
] satisfies Prisma.ProjectMemoryVersionOrderByWithRelationInput[];

/** The same order reversed, for reading the current memory on its own. */
const NEWEST_FIRST = [
  { createdAt: 'desc' },
  { seq: 'desc' },
] satisfies Prisma.ProjectMemoryVersionOrderByWithRelationInput[];

/**
 * What the memory says now, or null where it says nothing yet — the base a
 * proposal is written against, and the base an accept is checked against.
 * One function, so those two cannot come to read the versions differently.
 */
async function currentContent(
  prisma: Prisma.TransactionClient,
  projectId: string,
): Promise<string | null> {
  const current = await prisma.projectMemoryVersion.findFirst({
    where: { projectId },
    orderBy: NEWEST_FIRST,
    select: { content: true },
  });
  return current?.content ?? null;
}

/**
 * The memory read shared by the GET route and the write route's answer: the
 * latest version's content, the count, and the size against the budget.
 */
async function readMemory(prisma: RouteDependencies['prisma'], projectId: string) {
  const versions = await prisma.projectMemoryVersion.findMany({
    where: { projectId },
    orderBy: OLDEST_FIRST,
    select: versionSelect,
  });
  const current = versions.at(-1);
  return {
    projectId,
    content: current?.content ?? null,
    versions: versions.length,
    size: current?.content.length ?? 0,
    budget: MEMORY_BUDGET,
    versionedAt: current?.createdAt ?? null,
  };
}

/** The two answers a proposal that is no longer answerable gets. */
const ALREADY_RESOLVED = 'that proposal is already resolved';
const MEMORY_HAS_MOVED = 'the memory has changed since that was proposed';

/** Thrown inside a transaction to roll it back as one of those two. */
class AlreadyResolved extends Error {}
class BaseHasMoved extends Error {}

export function memoryRoutes(
  v1: FastifyInstance,
  { prisma, queue, timeSource }: RouteDependencies,
): void {
  const stream = progressStreams(v1);

  /**
   * The engineer writes memory directly (story 98's other half: every word is
   * there because the engineer put it there, agent or not).
   *
   * A new version, and nothing written to the one it follows — the record of
   * what the memory said stands, which is what "versioned" means in the
   * ticket. This is also the path an accept-with-edit takes, with the
   * proposal stamped onto the version.
   */
  v1.post<{ Params: { id: string }; Body: { content: string } }>(
    '/projects/:id/memory',
    { schema: { body: writeBodySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const at = timeSource.now();
      const content = request.body.content;
      await prisma.$transaction(async (tx) => {
        await tx.projectMemoryVersion.create({
          data: { projectId: project.id, content, createdAt: at },
        });
        await tx.auditEntry.create({
          data: {
            projectId: project.id,
            action: 'memory written',
            detail: `${content.length} characters written directly`,
            createdAt: at,
          },
        });
      });

      return reply.code(201).send(await readMemory(prisma, project.id));
    },
  );

  /**
   * The current memory, by project identity and nothing else (story 102).
   *
   * There is no query parameter and no ranking: retrieval by identity is the
   * whole of ADR-0019, and memory is the record that ADR was written about.
   * The size and the budget ride on every read so the interface can push
   * back as the document fills (story 101).
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/memory',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      return readMemory(prisma, project.id);
    },
  );

  /** The whole history, oldest first — what the memory has ever said. */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/memory/versions',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      return prisma.projectMemoryVersion.findMany({
        where: { projectId: project.id },
        orderBy: OLDEST_FIRST,
        select: versionSelect,
      });
    },
  );

  /**
   * Asking the agent for a proposal (story 99).
   *
   * The run is a row first and a job second — the row is what the screen
   * watches, and the job carries the id and nothing else, so one that sat in
   * Redis across a restart cannot go stale. Off the request, because a paid
   * model call is of unbounded duration: ADR-0034's case, not ADR-0032's.
   */
  v1.post<{ Params: { id: string } }>(
    '/projects/:id/memory/runs',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const run = await prisma.agentRun.create({
        data: { projectId: project.id, createdAt: timeSource.now() },
        select: runSelect,
      });
      await queue.add(PROPOSE_MEMORY_EDIT, {
        agentRunId: run.id,
      } satisfies ProposeMemoryEditJob);
      return reply.code(201).send(runOnTheWire(run));
    },
  );

  /** This job's runs, oldest first, with each one's state derived. */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/memory/runs',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      const runs = await prisma.agentRun.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: runSelect,
      });
      return runs.map(runOnTheWire);
    },
  );

  /**
   * The agent's one mutating tool lands here (story 99).
   *
   * What it writes is a **proposal**: memory itself is touched only by the
   * accept route, which the agent has no tool for. The base is snapshotted
   * onto the row — what the memory said when the proposal was written — so
   * the diff the engineer reviews cannot drift as the memory moves
   * underneath it, the snapshot shape ADR-0027 gave an issuance.
   *
   * One proposal per run: `run_id` is unique, and a second call is refused by
   * the database rather than by a guard.
   */
  v1.post<{ Params: { id: string }; Body: { content: string } }>(
    '/memory-runs/:id/proposal',
    { schema: { body: proposalBodySchema } },
    async (request, reply) => {
      const run = await prisma.agentRun.findUnique({
        where: { id: request.params.id },
        select: { id: true, projectId: true },
      });
      if (run === null) {
        return reply.code(404).send({ message: 'no agent run with that id' });
      }

      const current = await currentContent(prisma, run.projectId);

      const at = timeSource.now();
      const content = request.body.content;
      try {
        const proposal = await prisma.$transaction(async (tx) => {
          const written = await tx.memoryProposal.create({
            data: {
              projectId: run.projectId,
              runId: run.id,
              baseContent: current,
              proposed: content,
              createdAt: at,
            },
            select: proposalSelect,
          });
          await tx.auditEntry.create({
            data: {
              projectId: run.projectId,
              action: 'proposal written',
              detail: `the agent proposed ${content.length} characters`,
              createdAt: at,
            },
          });
          return written;
        });
        return reply.code(201).send(proposalOnTheWire(proposal, current));
      } catch (error) {
        // Narrowed to the run: one run, at most one proposal.
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that run has already proposed' });
        }
        throw error;
      }
    },
  );

  /** This job's proposals, oldest first, pending and resolved alike. */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/memory/proposals',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      const [proposals, current] = await Promise.all([
        prisma.memoryProposal.findMany({
          where: { projectId: project.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: proposalSelect,
        }),
        currentContent(prisma, project.id),
      ]);
      return proposals.map((proposal) => proposalOnTheWire(proposal, current));
    },
  );

  /**
   * Accepting a proposal — verbatim, or edited first (story 100).
   *
   * This is the only route that turns a proposal into memory. Supplied
   * `content` is the engineer's edited text and is what the version carries;
   * the proposal row keeps the agent's own words, so "the engineer changed
   * it before taking it" stays checkable afterwards — the transcript's two
   * facts (ADR-0034), arrived at for a second record. A resolved proposal is
   * refused rather than re-answered, as a response and a disposition are.
   */
  v1.post<{ Params: { id: string }; Body: { content?: string } }>(
    '/memory-proposals/:id/accept',
    { schema: { body: acceptBodySchema } },
    async (request, reply) => {
      const proposal = await prisma.memoryProposal.findUnique({
        where: { id: request.params.id },
        select: proposalSelect,
      });
      if (proposal === null) {
        return reply.code(404).send({ message: 'no proposal with that id' });
      }
      if (proposal.acceptedAt !== null || proposal.rejectedAt !== null) {
        return reply
          .code(409)
          .send({ message: ALREADY_RESOLVED });
      }

      const at = timeSource.now();
      const edited = request.body.content;
      const content = edited ?? proposal.proposed;
      try {
        await prisma.$transaction(async (tx) => {
          // The stamps are put in the `where` and the count checked, so the
          // answer is written by the same statement that reads it. The
          // check above is a read and a concurrent reject passed it too
          // (issue #42); this is what makes the answer exactly one.
          const settled = await tx.memoryProposal.updateMany({
            where: { id: proposal.id, acceptedAt: null, rejectedAt: null },
            data: { acceptedAt: at },
          });
          if (settled.count === 0) {
            throw new AlreadyResolved();
          }

          // What the diff under review was drawn against, checked against
          // what the memory says now. The base is snapshotted on purpose
          // (ADR-0040) and stays snapshotted; what was missing was any
          // signal that it had gone out of date, and committing text
          // composed against an older version silently drops whatever was
          // written in between.
          //
          // Read inside the transaction so a write that landed while the
          // engineer was reading is seen. A direct write that commits
          // between this read and the version below still slips past —
          // narrow, and not closed here, because closing it means locking
          // the project the way `routes/ingest.ts` does and the record this
          // guards is one engineer's own prose.
          if ((await currentContent(tx, proposal.projectId)) !== proposal.baseContent) {
            throw new BaseHasMoved();
          }

          await tx.projectMemoryVersion.create({
            data: {
              projectId: proposal.projectId,
              content,
              proposalId: proposal.id,
              createdAt: at,
            },
          });
          await tx.auditEntry.create({
            data: {
              projectId: proposal.projectId,
              action:
                edited === undefined || edited === proposal.proposed
                  ? 'proposal accepted'
                  : 'proposal accepted with edits',
              detail: `${content.length} characters committed`,
              createdAt: at,
            },
          });
        });
      } catch (error) {
        if (error instanceof BaseHasMoved) {
          return reply.code(409).send({ message: MEMORY_HAS_MOVED });
        }
        if (error instanceof AlreadyResolved || isUniqueViolation(error)) {
          // The version's `proposal_id` unique lost a race the resolved-check
          // above could not see. Same refusal, later.
          return reply
            .code(409)
            .send({ message: ALREADY_RESOLVED });
        }
        throw error;
      }

      return readMemory(prisma, proposal.projectId);
    },
  );

  /**
   * Rejecting a proposal (story 100). The row stands — what the agent
   * suggested and that the engineer declined it are both part of the record.
   */
  v1.post<{ Params: { id: string } }>(
    '/memory-proposals/:id/reject',
    async (request, reply) => {
      const proposal = await prisma.memoryProposal.findUnique({
        where: { id: request.params.id },
        select: proposalSelect,
      });
      if (proposal === null) {
        return reply.code(404).send({ message: 'no proposal with that id' });
      }
      if (proposal.acceptedAt !== null || proposal.rejectedAt !== null) {
        return reply
          .code(409)
          .send({ message: ALREADY_RESOLVED });
      }

      const at = timeSource.now();
      try {
        await prisma.$transaction(async (tx) => {
          // Compare-and-set, and first in the transaction so the audit row
          // rolls back with it: the check above is a read, and a concurrent
          // accept passed it too — both committed, and the proposal ended
          // with both stamps and two audit lines (issue #42).
          const settled = await tx.memoryProposal.updateMany({
            where: { id: proposal.id, acceptedAt: null, rejectedAt: null },
            data: { rejectedAt: at },
          });
          if (settled.count === 0) {
            throw new AlreadyResolved();
          }
          await tx.auditEntry.create({
            data: {
              projectId: proposal.projectId,
              action: 'proposal rejected',
              detail: `${proposal.proposed.length} characters declined`,
              createdAt: at,
            },
          });
        });
      } catch (error) {
        if (error instanceof AlreadyResolved) {
          return reply.code(409).send({ message: ALREADY_RESOLVED });
        }
        throw error;
      }
      return proposalOnTheWire(
        { ...proposal, rejectedAt: at },
        await currentContent(prisma, proposal.projectId),
      );
    },
  );

  /**
   * The audit of every mutation above (story 106), oldest first — an audit
   * is read in the order it was written.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/memory/audit',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      return prisma.auditEntry.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    },
  );

  /**
   * The runs and proposals as they move, over the shared stream machinery
   * (ADR-0035's leaf, reached for a third time). The state, never a
   * percentage — what the engineer sees moving is queued, running, and the
   * proposal arriving.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/memory/stream',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      const projectId = project.id;
      await stream(request, reply, async () => {
        const [runs, proposals, current] = await Promise.all([
          prisma.agentRun.findMany({
            where: { projectId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: runSelect,
          }),
          prisma.memoryProposal.findMany({
            where: { projectId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: proposalSelect,
          }),
          currentContent(prisma, projectId),
        ]);
        return {
          runs: runs.map(runOnTheWire),
          proposals: proposals.map((proposal) =>
            proposalOnTheWire(proposal, current),
          ),
        };
      });
    },
  );
}
