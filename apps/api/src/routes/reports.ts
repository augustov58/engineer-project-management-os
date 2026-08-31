/** The site visit report, and the queued rendering that produces it (issue #13). */

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { RouteDependencies } from '../http.js';
import { noSuchSiteVisit, noSuchSiteVisitReport } from '../refusals.js';
import { progressStreams } from '../stream.js';
import { reportOnTheWire, reportsMade } from '../wire.js';
import { RENDER_REPORT, type RenderReportJob } from '../worker.js';

/** The reports asked for on a walk, in the order they were asked for. */
function reportsOn(prisma: PrismaClient, siteVisitId: string) {
  return prisma.siteVisitReport
    .findMany({ where: { siteVisitId }, ...reportsMade })
    .then((rows) => rows.map(reportOnTheWire));
}

export function reportRoutes(
  v1: FastifyInstance,
  { prisma, queue, objectStore, timeSource }: RouteDependencies,
): void {
  const stream = progressStreams(v1);

  /**
   * Generating the write-up of a walk (stories 67 and 68).
   *
   * The row is written and a job goes on the queue; the document arrives
   * later. Rendering is on BullMQ rather than in the request — ADR-0032 kept
   * photo binning off it as "date comparison and one regular expression", and
   * ADR-0034 recorded that that sentence is spent rather than a general
   * licence. Printing a walk starts a browser, decodes every photograph on it
   * and lays out a paginated document; the ticket's own "with visible
   * progress" presupposes the request has long since returned.
   *
   * **A second call is a second report, not a refusal.** Nothing here is
   * edited, so a correction is another rendering dated its own moment — the
   * shape ADR-0028 gave a reissue and ADR-0029 gave a rerun of a calculation.
   * It is also the answer to the thing the walk screen is for: a finding read
   * as having no photograph yet (story 66) gets one, and the report is
   * generated again.
   */
  v1.post<{ Params: { id: string } }>(
    '/site-visits/:id/reports',
    async (request, reply) => {
      const walk = await prisma.siteVisit.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (walk === null) {
        return noSuchSiteVisit(reply);
      }

      const report = await prisma.siteVisitReport.create({
        data: { siteVisitId: walk.id, createdAt: timeSource.now() },
      });

      // After the row and outside any transaction. If this throws, the report
      // is stored and reads as queued, and asking again is a fresh one — which
      // is strictly better than a 500 that also loses the request.
      await queue.add(RENDER_REPORT, {
        siteVisitReportId: report.id,
      } satisfies RenderReportJob);

      return reply.code(201).send(reportOnTheWire(report));
    },
  );

  /**
   * The document itself.
   *
   * Through the API and not a presigned URL, for the reason a photograph's
   * bytes and a recording's are (ADR-0032): a presigned URL would be a second
   * thing reachable without the single edge gate ADR-0020 puts in front of
   * every route, and that ADR is still Proposed. `apps/web` proxies this so
   * the browser never calls the API directly.
   */
  v1.get<{ Params: { id: string } }>(
    '/site-visit-reports/:id/pdf',
    async (request, reply) => {
      const found = await prisma.siteVisitReport.findUnique({
        where: { id: request.params.id },
        select: { storageKey: true },
      });
      if (found === null) {
        return noSuchSiteVisitReport(reply);
      }
      if (found.storageKey === null) {
        // The report exists and its document does not — it is queued, still
        // rendering, or it failed. A 404 would say the report was not there,
        // which is a different thing and the screen shows the difference.
        return reply
          .code(409)
          .send({ message: 'that report has not been rendered' });
      }

      const bytes = await objectStore.get(found.storageKey);
      return reply
        .header('content-type', 'application/pdf')
        // Always a PDF — there is no content type on the row to disagree with
        // this — and the browser is told not to look for anything else.
        .header('x-content-type-options', 'nosniff')
        .send(bytes);
    },
  );

  /**
   * Progress while it renders, so a slow document does not look like a broken
   * feature (the ticket's "with visible progress").
   *
   * The stream is `stream.ts`, which a walk's recordings reach for too
   * (issue #12). What is this record's is the reader. What moves is the
   * **state** and never a percentage: ADR-0034 refused to invent one for a
   * vendor's progress, and a fraction of a page count would be the same lie
   * told about a browser.
   */
  v1.get<{ Params: { id: string } }>(
    '/site-visits/:id/reports/stream',
    async (request, reply) => {
      const walk = await prisma.siteVisit.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (walk === null) {
        return noSuchSiteVisit(reply);
      }

      return stream(request, reply, () => reportsOn(prisma, walk.id));
    },
  );
}
