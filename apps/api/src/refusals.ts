/**
 * Every way this API says no, in one place.
 *
 * The 404s are one line each and read as a set: a route names the record it
 * could not find rather than assembling a body. The two async ones below them
 * are the checks more than one record has to make before writing.
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

/**
 * The one already-superseded body. Said twice by the reissue route — once by
 * the check that reads the successor, once by the index catching a race — and
 * a reworded message must not become two different sentences.
 */
export function alreadySuperseded(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ message: 'that submission has already been superseded' });
}

/** The one 404 body for assumption records, matching the others. */
export function noSuchAssumptionRecord(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no assumption record with that id' });
}

/** The one 404 body for site visits, matching the others. */
export function noSuchSiteVisit(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no site visit with that id' });
}

/**
 * The one end-before-start body. Said twice — once by the create route, once
 * by the end route — and a reworded message must not become two different
 * sentences, for the reason `alreadySuperseded` is one function.
 */
export function endsBeforeItStarted(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ message: 'a site visit cannot end before it started' });
}

/** The one 404 body for a floor's entry in a visit's schedule. */
export function noSuchFloor(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no floor with that id' });
}

/** The one 404 body for issues, matching the others. */
export function noSuchIssue(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no issue with that id' });
}

/** The one 404 body for observations, matching the others. */
export function noSuchObservation(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no observation with that id' });
}

/** The one 404 body for photographs, matching the others. */
export function noSuchPhoto(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no photo with that id' });
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
