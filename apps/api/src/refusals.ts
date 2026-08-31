/**
 * The refusals more than one route module reaches for.
 *
 * The sixteen 404s are here as a **set** rather than by the count rule ADR-0033
 * otherwise applies — most are used by one record, but a route naming the
 * record it could not find is the thing that must not drift into sixteen
 * differently worded bodies. Below them are the two async checks a record
 * makes before writing that another record makes too.
 *
 * The 4xx bodies a single record sends inline stay with that record; there are
 * thirty-two of them, and hoisting them here would empty the route modules of
 * the reasons they refuse.
 */

import type { FastifyReply } from 'fastify';
import { type PrismaClient } from '../generated/prisma/client.js';

/**
 * Why a record named in a request cannot be used here. Missing is a 404;
 * belonging to another job is a 409, because it exists and is simply not
 * this project's to issue at or to rest on.
 */
export interface Refusal {
  code: number;
  message: string;
}

export function refuse(reply: FastifyReply, refusal: Refusal) {
  return reply.code(refusal.code).send({ message: refusal.message });
}

/** The one 404 body, so the two lookup routes cannot drift apart. */
export function noSuchProject(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no project with that id' });
}

/** The one 404 body for open items, matching the projects one. */
export function noSuchOpenItem(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no open item with that id' });
}

/** The one 404 body for phases, matching the projects one. */
export function noSuchPhase(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no phase with that id' });
}

/** The one 404 body for submissions, matching the projects one. */
export function noSuchSubmission(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no submission with that id' });
}

/** The one 404 body for assumption records, matching the others. */
export function noSuchAssumptionRecord(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no assumption record with that id' });
}

/** The one 404 body for site visits, matching the others. */
export function noSuchSiteVisit(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no site visit with that id' });
}

/** The one 404 body for a floor's entry in a visit's schedule. */
export function noSuchFloor(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no floor with that id' });
}

/** The one 404 body for issues, matching the others. */
export function noSuchIssue(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no issue with that id' });
}

/**
 * The one 404 body for observations, matching the others — and exported,
 * because `observationRefusal` in `routes/issues.ts` answers the same miss in
 * the `Refusal` shape and the two sentences must stay one sentence.
 */
export const NO_SUCH_OBSERVATION = 'no observation with that id';

/** The one 404 body for observations, matching the others. */
export function noSuchObservation(reply: FastifyReply) {
  return reply.code(404).send({ message: NO_SUCH_OBSERVATION });
}

/** The one 404 body for photographs, matching the others. */
export function noSuchPhoto(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no photo with that id' });
}

/** The one 404 body for voice captures, matching the others. */
export function noSuchVoiceCapture(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no voice capture with that id' });
}

/** The one 404 body for registers, matching the others. */
export function noSuchRegister(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no register with that id' });
}

/** The one 404 body for register entries, matching the others. */
export function noSuchRegisterEntry(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no register entry with that id' });
}

/** The one 404 body for documents, matching the others. */
export function noSuchDocument(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no document with that id' });
}

/**
 * The one 404 body for document versions, matching the others — and exported
 * as a constant too, because `versionRefusal` in `routes/documents.ts` answers
 * the same miss in the `Refusal` shape and the two sentences must stay one
 * sentence. `NO_SUCH_OBSERVATION` is here for that reason and is the
 * precedent.
 */
export const NO_SUCH_DOCUMENT_VERSION = 'no document version with that id';

/** The one 404 body for document versions, matching the others. */
export function noSuchDocumentVersion(reply: FastifyReply) {
  return reply.code(404).send({ message: NO_SUCH_DOCUMENT_VERSION });
}

/** The one 404 body for site visit reports, matching the others. */
export function noSuchSiteVisitReport(reply: FastifyReply) {
  return reply
    .code(404)
    .send({ message: 'no site visit report with that id' });
}

export async function phaseRefusal(
  prisma: PrismaClient,
  phaseId: string,
  projectId: string,
): Promise<Refusal | null> {
  const phase = await prisma.projectPhase.findUnique({
    where: { id: phaseId },
    select: { projectId: true },
  });
  if (phase === null) {
    return { code: 404, message: 'no phase with that id' };
  }
  if (phase.projectId !== projectId) {
    return { code: 409, message: 'that phase belongs to another project' };
  }
  return null;
}

export async function openItemRefusal(
  prisma: PrismaClient,
  openItemId: string,
  projectId: string,
): Promise<Refusal | null> {
  const item = await prisma.openItem.findUnique({
    where: { id: openItemId },
    select: { subjectType: true, subjectId: true },
  });
  if (item === null) {
    return { code: 404, message: 'no open item with that id' };
  }
  if (item.subjectType !== 'PROJECT' || item.subjectId !== projectId) {
    return { code: 409, message: 'that open item is on another project' };
  }
  return null;
}
