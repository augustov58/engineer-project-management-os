import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  addDocumentVersion,
  markReferencedFile,
  requestExtractionFromDocument,
} from './actions';
import { DocumentVersionForm } from './document-form';
import { day } from './open-item';
import {
  documentKind,
  type DocumentVersion,
  type LinkedDocumentVersion,
  type StoredDocument,
} from './api';

/**
 * Kilobytes and megabytes, so a list says how big a set is at a glance.
 *
 * Decimal, because the label says kB and MB: a thousand-based divisor is what
 * those two mean, and dividing by 1024 under them would print a number four
 * per cent short of what the file manager beside it says.
 */
function size(bytes: number): string {
  return bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} kB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * One revision, linking to its bytes.
 *
 * Through the Next server and never straight at the API: a link pointed at
 * `NEXT_PUBLIC_API_URL` would work on this machine and fail on the second
 * device, and it would be the one request in the product going around whatever
 * ADR-0020 eventually puts in front of the API.
 */
function VersionRow({ version }: { version: DocumentVersion }) {
  return (
    <a
      href={`/document-versions/${version.id}/bytes`}
      target="_blank"
      rel="noreferrer"
      className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-2 text-sm transition-colors"
    >
      <Badge variant="outline" className="font-mono">
        {version.revision}
      </Badge>
      <span className="font-medium break-all">{version.filename}</span>
      <span className="text-muted-foreground tabular-nums">
        {size(version.byteSize)}
      </span>
      <span className="text-muted-foreground">
        stored {day(version.createdAt)}
      </span>
    </a>
  );
}

/**
 * What is stored against a job, with every revision each document has had.
 *
 * The revisions are all shown rather than only the newest: a submission points
 * at the one it went out against, and a list that hid the older ones would
 * hide what that link means.
 */
export function DocumentList({
  documents,
  projectId,
}: {
  documents: StoredDocument[];
  projectId: string;
}) {
  if (documents.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
        Nothing stored on this job yet.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {documents.map((document) => (
        <li key={document.id} className="space-y-1 py-2">
          <div className="flex flex-wrap items-center gap-3 px-4 pt-1">
            <span className="font-medium">{document.title}</span>
            <Badge
              variant={document.referencedFile ? 'secondary' : 'outline'}
              title={
                document.referencedFile
                  ? 'Stored and linked, and never an extraction target'
                  : 'Something extraction could be pointed at'
              }
            >
              {documentKind(document)}
            </Badge>
            <span className="text-muted-foreground text-sm">
              {document.versions.length}{' '}
              {document.versions.length === 1 ? 'version' : 'versions'}
            </span>
            {/*
              Marking one after the fact, which the screen offers only where it
              would change something. One way and never back: a correction may
              always take a document out of extraction's reach and may never
              put one into it, so there is no control here that unmarks.
            */}
            {!document.referencedFile && (
              <>
                {/*
                  Asking for an extraction over the latest version (issue #20).
                  Offered exactly where the referenced-file mark is not: the
                  two are the same predicate, so this button and that badge
                  can never disagree.
                */}
                <form
                  action={requestExtractionFromDocument.bind(
                    null,
                    projectId,
                    document.id,
                  )}
                >
                  <Button type="submit" variant="ghost" size="sm">
                    Extract
                  </Button>
                </form>
                <form
                  action={markReferencedFile.bind(null, document.id, projectId)}
                >
                  <Button type="submit" variant="ghost" size="sm">
                    Mark as a referenced file
                  </Button>
                </form>
              </>
            )}
          </div>
          <div className="divide-y">
            {document.versions.map((version) => (
              <VersionRow key={version.id} version={version} />
            ))}
          </div>
          {/*
            A newer revision, added where the document is. Nothing above is
            overwritten — the rows stay, which is what makes "which version did
            we issue against" answerable once a submission points at one.
          */}
          <div className="px-4 pb-1">
            <DocumentVersionForm
              submit={addDocumentVersion.bind(null, document.id, projectId)}
              documentId={document.id}
              title={document.title}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The versions an issuance or a register entry points at, each carrying the
 * document it is a revision of.
 *
 * The revision is what is named rather than the document alone, because it is
 * the answer to "which version did we issue against".
 */
export function LinkedDocumentList({
  versions,
  empty,
}: {
  versions: LinkedDocumentVersion[];
  empty: string;
}) {
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
        {empty}
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {versions.map((version) => (
        <li key={version.id}>
          <a
            href={`/document-versions/${version.id}/bytes`}
            target="_blank"
            rel="noreferrer"
            className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
          >
            <span className="font-medium">{version.document.title}</span>
            <Badge variant="outline" className="font-mono">
              {version.revision}
            </Badge>
            <span className="text-muted-foreground text-sm break-all">
              {version.filename}
            </span>
            <span className="text-muted-foreground text-sm tabular-nums">
              {size(version.byteSize)}
            </span>
            {version.document.referencedFile && (
              <Badge variant="secondary">Referenced file</Badge>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
