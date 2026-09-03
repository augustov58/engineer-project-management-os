/** The whole record, in one document (story 113). */

import type { FastifyInstance } from 'fastify';
import type { RouteDependencies } from '../http.js';

/**
 * Where a stored object's bytes are served, by the record that points at them.
 *
 * A `storage_key` never reaches the wire — ADR-0032 settled that for a
 * photograph and every later record followed — so an export cannot simply
 * carry the column. It carries the path that serves those bytes instead,
 * which is the honest substitute: it says the file exists, says where to get
 * it, and leaks nothing about how this deployment stores it. An export is
 * therefore a document plus the fetches it names, not a single archive; the
 * alternative is base64 in the same body, and a walk's photographs would make
 * that a response nobody can hold in memory.
 */
const BYTES_PATH = {
  photo: (id: string) => `/v1/photos/${id}/bytes`,
  voiceCapture: (id: string) => `/v1/voice-captures/${id}/audio`,
  siteVisitReport: (id: string) => `/v1/site-visit-reports/${id}/pdf`,
  documentVersion: (id: string) => `/v1/document-versions/${id}/bytes`,
  ingestedDocumentFile: (id: string) =>
    `/v1/ingested-document-files/${id}/bytes`,
} as const;

/**
 * A row with its `storageKey` swapped for the path that serves it.
 *
 * `bytes` is null exactly when the key is: a site visit report that has not
 * finished rendering has no file, and saying so is different from omitting the
 * field.
 */
function withBytes<T extends { id: string; storageKey: string | null }>(
  row: T,
  path: (id: string) => string,
): Omit<T, 'storageKey'> & { bytes: string | null } {
  const { storageKey, ...rest } = row;
  return { ...rest, bytes: storageKey === null ? null : path(row.id) };
}

export function exportRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * Every record this product holds, in one JSON document (story 113).
   *
   * The story's reason is the PRD's own goal — "changing employers does not
   * mean losing the record" — so this is deliberately **not** scoped to a
   * project and takes no filter. A per-project export would answer a
   * different question, and the one being asked is "all of it".
   *
   * Ordered by primary key throughout rather than by a timestamp: two rows
   * written in the same transaction share an instant, and an export that
   * reorders itself between two runs cannot be diffed against the last one.
   * The eight join tables have no `id` — their key is the pair of things
   * they join — so each is ordered by that pair.
   *
   * It is behind the edge gate like everything else (ADR-0020). That matters
   * more here than anywhere: this one response is the entire database, so it
   * is the single most valuable thing the gate stands in front of.
   *
   * **The size is not bounded and deliberately so.** Every row of every table
   * is read into memory and serialised at once. For the six live projects
   * ADR-0012 sizes this product for, that is a document measured in
   * megabytes; the bytes themselves stay behind the paths above, which is
   * what keeps it that small. If it ever stops being small, the fix is to
   * stream the tables one at a time, not to paginate the export.
   */
  v1.get('/export', async () => {
    const by = { orderBy: { id: 'asc' } } as const;

    const [
      projects,
      projectPhases,
      submissions,
      submissionOpenItems,
      openItems,
      assumptionRecords,
      counterfactuals,
      raisedFlags,
      siteVisits,
      siteVisitFloors,
      observations,
      issues,
      issueObservations,
      issueOpenItems,
      photos,
      voiceCaptures,
      siteVisitReports,
      registers,
      registerEntries,
      ballInCourtEvents,
      registerEntryOpenItems,
      documents,
      documentVersions,
      submissionDocumentVersions,
      registerEntryDocumentVersions,
      projectMemoryVersions,
      memoryProposals,
      agentRuns,
      auditEntries,
      ingestedDocuments,
      ingestedDocumentFiles,
      registerEntryExtractions,
    ] = await Promise.all([
      prisma.project.findMany(by),
      prisma.projectPhase.findMany(by),
      prisma.submission.findMany(by),
      prisma.submissionOpenItem.findMany({ orderBy: [{ submissionId: 'asc' }, { openItemId: 'asc' }] }),
      prisma.openItem.findMany(by),
      prisma.assumptionRecord.findMany(by),
      prisma.counterfactual.findMany({ orderBy: [{ assumptionRecordId: 'asc' }, { line: 'asc' }] }),
      prisma.raisedFlag.findMany({ orderBy: [{ assumptionRecordId: 'asc' }, { line: 'asc' }] }),
      prisma.siteVisit.findMany(by),
      prisma.siteVisitFloor.findMany(by),
      prisma.observation.findMany(by),
      prisma.issue.findMany(by),
      prisma.issueObservation.findMany({ orderBy: [{ issueId: 'asc' }, { observationId: 'asc' }] }),
      prisma.issueOpenItem.findMany({ orderBy: [{ issueId: 'asc' }, { openItemId: 'asc' }] }),
      prisma.photo.findMany(by),
      prisma.voiceCapture.findMany(by),
      prisma.siteVisitReport.findMany(by),
      prisma.register.findMany(by),
      prisma.registerEntry.findMany(by),
      prisma.ballInCourtEvent.findMany(by),
      prisma.registerEntryOpenItem.findMany({ orderBy: [{ registerEntryId: 'asc' }, { openItemId: 'asc' }] }),
      prisma.document.findMany(by),
      prisma.documentVersion.findMany(by),
      prisma.submissionDocumentVersion.findMany({ orderBy: [{ submissionId: 'asc' }, { documentVersionId: 'asc' }] }),
      prisma.registerEntryDocumentVersion.findMany({ orderBy: [{ registerEntryId: 'asc' }, { documentVersionId: 'asc' }] }),
      prisma.projectMemoryVersion.findMany(by),
      prisma.memoryProposal.findMany(by),
      prisma.agentRun.findMany(by),
      prisma.auditEntry.findMany(by),
      prisma.ingestedDocument.findMany(by),
      prisma.ingestedDocumentFile.findMany(by),
      prisma.registerEntryExtraction.findMany(by),
    ]);

    return {
      /**
       * When this document was made, from the injected clock (ADR-0022), so a
       * test can assert it rather than tolerate it.
       */
      exportedAt: timeSource.now().toISOString(),

      /**
       * What an importer would have to understand. Bumped when a shape here
       * changes in a way that would break one — not when a table gains a
       * column, which is additive and which an importer can ignore.
       */
      version: 1,

      records: {
        /**
         * `ingestToken` is dropped and not renamed. It is a credential: an
         * address built from it receives mail from anyone who knows it
         * (ADR-0042), and its unguessability is what stands in the edge
         * gate's place for the one route the gate lets by. It is also the one
         * value here that can simply be minted again, so nothing is lost by
         * leaving it out and something real is risked by carrying it into a
         * file that will sit in cloud storage somewhere.
         */
        projects: projects.map(({ ingestToken: _dropped, ...rest }) => rest),
        projectPhases,
        submissions,
        submissionOpenItems,
        openItems,
        assumptionRecords,
        counterfactuals,
        raisedFlags,
        siteVisits,
        siteVisitFloors,
        observations,
        issues,
        issueObservations,
        issueOpenItems,
        photos: photos.map((row) => withBytes(row, BYTES_PATH.photo)),
        voiceCaptures: voiceCaptures.map((row) =>
          withBytes(row, BYTES_PATH.voiceCapture),
        ),
        siteVisitReports: siteVisitReports.map((row) =>
          withBytes(row, BYTES_PATH.siteVisitReport),
        ),
        registers,
        registerEntries,
        ballInCourtEvents,
        registerEntryOpenItems,
        documents,
        documentVersions: documentVersions.map((row) =>
          withBytes(row, BYTES_PATH.documentVersion),
        ),
        submissionDocumentVersions,
        registerEntryDocumentVersions,
        projectMemoryVersions,
        memoryProposals,
        agentRuns,
        auditEntries,
        ingestedDocuments,
        ingestedDocumentFiles: ingestedDocumentFiles.map((row) =>
          withBytes(row, BYTES_PATH.ingestedDocumentFile),
        ),
        registerEntryExtractions,
      },
    };
  });
}
