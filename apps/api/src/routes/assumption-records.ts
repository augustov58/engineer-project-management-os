/** Assumption records, their counterfactuals, and flags raised (issue #8). */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import {
  NOT_BLANK,
  type RouteDependencies,
  instant,
  isUniqueViolation,
} from '../http.js';
import {
  type Refusal,
  noSuchAssumptionRecord,
  noSuchSubmission,
  refuse,
} from '../refusals.js';
import { UNRESOLVED_MAX, openItemBodySchema } from './open-items.js';
import { itemOnSubmission } from './submissions.js';

/**
 * The durable artifact of engineering reasoning (issue #8): two blocks
 * captured verbatim from a helper skill's output, with the code edition and
 * the date.
 *
 * The caps follow the sheet list's reasoning — this is the other field that
 * holds a list rather than a phrase, and real output from the three
 * calculators runs to a handful of lines and about a kilobyte. The code
 * edition gets the project name's 200, because one calculation may be done
 * against five standards at once.
 *
 * There is no `submissionId` here: which issuance a record justified is the
 * route it was captured on, not something a body may assert.
 */
const assumptionRecordBodySchema = {
  type: 'object',
  required: ['assumptions', 'flags', 'codeEdition'],
  additionalProperties: false,
  properties: {
    assumptions: { type: 'string', pattern: NOT_BLANK, maxLength: 4000 },
    flags: { type: 'string', pattern: NOT_BLANK, maxLength: 4000 },
    codeEdition: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    // Settable, because the calculation worth capturing first was run long
    // before this row existed; otherwise the injected TimeSource (ADR-0022).
    calculatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Capped at the open item's, being the same field on the other record. */
const counterfactualBodySchema = {
  type: 'object',
  required: ['counterfactual'],
  additionalProperties: false,
  properties: {
    counterfactual: { type: 'string', pattern: NOT_BLANK, maxLength: 1000 },
  },
} as const;

/**
 * An open item raised from a flag. The same fields as any other, except that
 * `unresolved` may be left off — the flag already says what is unresolved,
 * and story 40's point is that nothing about it gets transcribed by hand.
 *
 * The property definitions are the open item's own rather than a second copy,
 * so the caps cannot drift apart.
 */
const raisedFlagBodySchema = {
  type: 'object',
  required: ['blocks', 'waitingOn', 'counterfactual'],
  additionalProperties: false,
  properties: openItemBodySchema.properties,
} as const;

/** Which entry of a captured block a route is pointed at. */
const blockLineParamsSchema = {
  type: 'object',
  required: ['id', 'line'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    line: { type: 'integer', minimum: 0 },
  },
} as const;

/**
 * The verbatim entry a line number addresses, or why it addresses none.
 *
 * A block is captured verbatim and never edited, so a line number is a stable
 * pointer into it — which is what lets a counterfactual and a raised flag name
 * an entry without a second copy of its wording existing to disagree with the
 * block. Past the end is a 404, because the caller named a line that is not
 * there; a line with nothing on it is a 409, because the line exists and is
 * simply not an entry.
 *
 * Every non-blank line is an entry. The three calculators all write one
 * assumption or flag per line under a header, prefixed `- ` and `! `, but
 * those sigils are their convention and not a contract — reading them here
 * would make this refuse the next helper skill's output.
 */
function entryAt(
  block: string,
  line: number,
  named: 'assumptions' | 'flags',
): { text: string } | Refusal {
  const text = block.split('\n')[line];
  if (text === undefined) {
    return { code: 404, message: 'that block has no line with that number' };
  }
  if (!new RegExp(NOT_BLANK).test(text)) {
    return { code: 409, message: `that line of the ${named} block is blank` };
  }
  return { text };
}

/** The entries pointing into a record's blocks. */
const recordInclude = {
  counterfactuals: { select: { line: true, counterfactual: true } },
  raisedFlags: { select: { line: true, openItem: true } },
} as const;

type CapturedRecord = Prisma.AssumptionRecordGetPayload<{
  include: typeof recordInclude;
}>;

/**
 * A record on the wire: the blocks verbatim, plus each split into the entries
 * a line number addresses.
 *
 * The lines are derived on every read and stored nowhere, for the reason
 * *currently provisional* and *superseded* are (ADR-0027, ADR-0028). The
 * issuance is not joined: the record already names it by `submissionId`, and
 * two ways to read the same binding is the second place it can be wrong.
 */
function withLines(found: CapturedRecord) {
  const { counterfactuals, raisedFlags, ...record } = found;
  const written = new Map(
    counterfactuals.map((row) => [row.line, row.counterfactual]),
  );
  const raised = new Map(raisedFlags.map((row) => [row.line, row.openItem]));

  return {
    ...record,
    assumptionLines: record.assumptions.split('\n').map((text, line) => ({
      line,
      text,
      counterfactual: written.get(line) ?? null,
    })),
    flagLines: record.flags.split('\n').map((text, line) => ({
      line,
      text,
      openItem: raised.get(line) ?? null,
    })),
  };
}

export function assumptionRecordRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * Capturing what a helper skill produced (issue #8, stories 36-38). The
   * two blocks go in verbatim — nothing here trims, normalises or re-wraps
   * them, and nothing here recomputes what they say.
   *
   * Bound to the submission it justified, which is the route it is
   * captured on. There is no route that updates one and none that deletes
   * one, for the reason a submission has neither: it is a capture of what
   * something else output at a moment. Running the calculation again is
   * another record against the same issuance, dated its own day.
   */
  v1.post<{
    Params: { id: string };
    Body: {
      assumptions: string;
      flags: string;
      codeEdition: string;
      calculatedAt?: string;
    };
  }>(
    '/submissions/:id/assumption-records',
    { schema: { body: assumptionRecordBodySchema } },
    async (request, reply) => {
      const set = await prisma.submission.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (set === null) {
        return noSuchSubmission(reply);
      }

      const { calculatedAt, ...rest } = request.body;
      const record = await prisma.assumptionRecord.create({
        data: {
          ...rest,
          submissionId: set.id,
          calculatedAt: instant(calculatedAt, timeSource),
          createdAt: timeSource.now(),
        },
        include: recordInclude,
      });
      return reply.code(201).send(withLines(record));
    },
  );

  /**
   * What was assumed when this went out (story 37), oldest calculation
   * first. Entry order breaks a tie, so two captures dated the same day do
   * not come back in an arbitrary one.
   */
  v1.get<{ Params: { id: string } }>(
    '/submissions/:id/assumption-records',
    async (request, reply) => {
      const set = await prisma.submission.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (set === null) {
        return noSuchSubmission(reply);
      }

      const listed = await prisma.assumptionRecord.findMany({
        where: { submissionId: set.id },
        orderBy: [{ calculatedAt: 'asc' }, { createdAt: 'asc' }],
        include: recordInclude,
      });
      return listed.map(withLines);
    },
  );

  /**
   * What changes if one assumed input turns out wrong (story 39). Written
   * against the line of the `ASSUMPTIONS` block it is about, so the
   * durable artifact is the reasoning and not a paragraph beside the
   * arithmetic.
   *
   * A second one on the same input is refused rather than repeated,
   * matching the resolve rule: a silent overwrite would lose the first
   * reading of a consequence, which is the part worth keeping.
   */
  v1.post<{
    Params: { id: string; line: number };
    Body: { counterfactual: string };
  }>(
    '/assumption-records/:id/assumptions/:line/counterfactual',
    {
      schema: {
        params: blockLineParamsSchema,
        body: counterfactualBodySchema,
      },
    },
    async (request, reply) => {
      const { id, line } = request.params;
      const record = await prisma.assumptionRecord.findUnique({
        where: { id },
        select: { assumptions: true },
      });
      if (record === null) {
        return noSuchAssumptionRecord(reply);
      }

      const entry = entryAt(record.assumptions, line, 'assumptions');
      if ('code' in entry) {
        return refuse(reply, entry);
      }

      try {
        const written = await prisma.counterfactual.create({
          data: {
            assumptionRecordId: id,
            line,
            counterfactual: request.body.counterfactual,
          },
          select: { line: true, counterfactual: true },
        });
        return reply.code(201).send(written);
      } catch (error) {
        // The composite key, and the only constraint this insert touches.
        if (isUniqueViolation(error)) {
          return reply.code(409).send({
            message: 'that assumed input already carries a counterfactual',
          });
        }
        throw error;
      }
    },
  );

  /**
   * A flag raised as an open item (story 40), so a flag raised during a
   * calculation cannot be raised and then forgotten.
   *
   * The item lands on the project and is attached to the submission the
   * record justified — the subject stays `PROJECT` (ADR-0026), because an
   * item that vanished from the project screen the moment it was tied to a
   * set would be the opposite of "nothing sitting in my court".
   *
   * It is attached *after* the issuance, so it is no part of what went out:
   * it makes the set currently provisional and puts it into exposure, and
   * leaves `issued_provisional` exactly as it was stamped (ADR-0027).
   */
  v1.post<{
    Params: { id: string; line: number };
    Body: {
      unresolved?: string;
      blocks: string;
      waitingOn: string | null;
      waitingSince?: string;
      invalidationTrigger?: string;
      counterfactual: string;
      owner?: string;
    };
  }>(
    '/assumption-records/:id/flags/:line/open-item',
    {
      schema: { params: blockLineParamsSchema, body: raisedFlagBodySchema },
    },
    async (request, reply) => {
      const { id, line } = request.params;
      const record = await prisma.assumptionRecord.findUnique({
        where: { id },
        select: {
          flags: true,
          submission: { select: { id: true, projectId: true } },
        },
      });
      if (record === null) {
        return noSuchAssumptionRecord(reply);
      }

      const entry = entryAt(record.flags, line, 'flags');
      if ('code' in entry) {
        return refuse(reply, entry);
      }

      const { unresolved, ...rest } = request.body;
      // Left off, the flag says what is unresolved in its own words —
      // which is the whole of "generate an open item directly from a
      // FLAGS / VERIFY entry". Only the surrounding whitespace goes: the
      // sigil the calculators prefix stays, because stripping it would be
      // this reading a format it has no contract with.
      const wording = unresolved ?? entry.text.trim();
      if (wording.length > UNRESOLVED_MAX) {
        return reply.code(409).send({
          message:
            'that flag is too long to become an open item on its own; say what is unresolved',
        });
      }

      try {
        const item = await prisma.$transaction(async (tx) => {
          const created = await tx.openItem.create({
            data: itemOnSubmission(
              rest,
              record.submission,
              wording,
              timeSource,
            ),
          });
          await tx.raisedFlag.create({
            data: { assumptionRecordId: id, line, openItemId: created.id },
          });
          return created;
        });
        return reply.code(201).send(item);
      } catch (error) {
        // Unqualified, and safe to be: every other row this transaction
        // writes carries a freshly generated id, so `raised_flags` is the
        // only constraint in it that anything can collide with. The
        // transaction rolls back, so a refused second raise leaves no open
        // item behind.
        if (isUniqueViolation(error)) {
          return reply.code(409).send({
            message: 'that flag has already been raised as an open item',
          });
        }
        throw error;
      }
    },
  );

  // ── Site visits and observations (issue #9) ──────────────────────────

}
