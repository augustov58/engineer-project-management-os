import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { ExtractionConfirmForm } from '../../../../extractions';
import { getExtraction, getProject } from '../../../../api';

/**
 * The confirmation screen (issue #20, stories 86 and 87): the proposal beside
 * the source, every field editable, and the two answers — confirm, or reject
 * and keep the source.
 *
 * The review is against what the agent actually read — the OCR text, and the
 * envelope on the mail path — rather than a rendering of the file itself,
 * because arrival bytes are served as `application/octet-stream` attachments
 * on purpose (ADR-0042) and this screen does not poke a hole in that. The
 * bytes are one click away, below.
 */
export default async function ExtractionPage({
  params,
}: {
  params: Promise<{ id: string; extractionId: string }>;
}) {
  const { id, extractionId } = await params;
  const [project, extraction] = await Promise.all([
    getProject(id),
    getExtraction(extractionId),
  ]);
  if (project === undefined || extraction === undefined) {
    notFound();
  }

  const arrivalPath = extraction.ingestedDocumentFileId !== null;
  const bytesHref = arrivalPath
    ? `/ingested-document-files/${extraction.ingestedDocumentFileId}/bytes`
    : `/document-versions/${extraction.documentVersionId}/bytes`;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {project.projectNumber} — {project.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Review the extraction
          </h1>
          <Badge variant="outline">{extraction.source.filename}</Badge>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          Nothing has committed. Confirming writes the entry — and, on the
          mail path, the document — in one action; rejecting keeps the source
          exactly as it arrived.
        </p>
      </div>

      {extraction.state !== 'pending' ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          {extraction.state === 'confirmed' ? (
            <>
              Confirmed —{' '}
              <Link
                href={`/register-entries/${extraction.registerEntryId}`}
                className="underline underline-offset-4"
              >
                the entry it became
              </Link>
              .
            </>
          ) : extraction.state === 'rejected' ? (
            'Rejected. The source stands as it arrived.'
          ) : extraction.state === 'failed' ? (
            <>The run failed: {extraction.failure}</>
          ) : (
            'This extraction has not proposed anything to review.'
          )}
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <h2 className="text-lg font-medium">What the agent read</h2>
            {'envelope' in extraction.source &&
              (extraction.source.envelope.sender !== null ||
                extraction.source.envelope.subject !== null ||
                extraction.source.envelope.body !== null) && (
                <div className="space-y-1 rounded-lg border p-4 text-sm">
                  {extraction.source.envelope.subject !== null && (
                    <p className="font-medium">
                      {extraction.source.envelope.subject}
                    </p>
                  )}
                  {extraction.source.envelope.sender !== null && (
                    <p className="text-muted-foreground text-xs">
                      from {extraction.source.envelope.sender}
                    </p>
                  )}
                  {extraction.source.envelope.body !== null && (
                    // Rendered as text and never as markup: this is a
                    // stranger's writing (ADR-0042).
                    <p className="text-muted-foreground max-h-32 overflow-y-auto text-xs whitespace-pre-wrap">
                      {extraction.source.envelope.body}
                    </p>
                  )}
                </div>
              )}
            <pre className="text-muted-foreground max-h-[32rem] overflow-auto rounded-lg border p-4 text-xs whitespace-pre-wrap">
              {extraction.ocrText ?? ''}
            </pre>
            <a
              href={bytesHref}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground text-sm underline underline-offset-4"
            >
              The file itself ({extraction.source.filename})
            </a>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-medium">The proposed entry</h2>
            <ExtractionConfirmForm projectId={id} extraction={extraction} />
          </section>
        </div>
      )}
    </div>
  );
}
