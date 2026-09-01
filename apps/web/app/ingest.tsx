import { Badge } from '@/components/ui/badge';
import type { IngestedDocument } from './api';

/** Bytes as a person reads them, matching the documents list. */
function size(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Where mail is forwarded to have it land on this job (stories 82 and 83).
 *
 * Shown in full and in monospace, because it is meant to be copied into a mail
 * client once and then forgotten. The only credential on a path that bypasses
 * this interface entirely, so the copy beside it says so rather than leaving
 * an address that looks like any other.
 */
export function IngestAddress({ address }: { address: string | null }) {
  if (address === null) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        No ingest domain is configured on this deployment, so this job has no
        forward-to address yet. Entering a document by hand works either way.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <p className="font-mono text-sm break-all">{address}</p>
      <p className="text-muted-foreground text-xs">
        Forward mail here and it lands on this job. Treat it as a password: it
        is unguessable on purpose and it is the only thing standing between this
        job and anyone who learns it. It accepts a limited number of messages an
        hour, and nothing that arrives is read or acted on &mdash; it is stored
        as it came in.
      </p>
    </div>
  );
}

/** What a message said about itself, or what the engineer typed instead. */
function Envelope({ arrival }: { arrival: IngestedDocument }) {
  if (arrival.source === 'MANUAL') {
    return (
      <p className="text-sm">
        {arrival.note ?? (
          <span className="text-muted-foreground">Entered by hand</span>
        )}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">
        {arrival.subject ?? (
          <span className="text-muted-foreground font-normal">No subject</span>
        )}
      </p>
      <p className="text-muted-foreground text-xs">from {arrival.sender}</p>
      {arrival.body !== null && (
        // Rendered as text and never as markup: this is a stranger's writing,
        // stored exactly as it arrived and read by nothing (ADR-0042).
        <p className="text-muted-foreground mt-2 max-h-32 overflow-y-auto text-xs whitespace-pre-wrap">
          {arrival.body}
        </p>
      )}
    </div>
  );
}

/**
 * What has arrived on this job and not yet been read.
 *
 * Deliberately not the documents list: these carry no title, no revision and
 * no referenced-file answer, because nobody has looked at them. Extraction
 * proposes those and the engineer confirms them, which is the next ticket.
 */
export function IngestedDocumentList({
  arrivals,
}: {
  arrivals: IngestedDocument[];
}) {
  if (arrivals.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
        Nothing has arrived on this job yet.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {arrivals.map((arrival) => (
        <li key={arrival.id} className="space-y-3 rounded-lg border p-4">
          <div className="flex items-start justify-between gap-4">
            <Envelope arrival={arrival} />
            <Badge
              variant={arrival.source === 'EMAIL' ? 'secondary' : 'outline'}
              title={
                arrival.source === 'EMAIL'
                  ? 'Forwarded to this job’s ingest address'
                  : 'Entered by hand, the fallback path'
              }
            >
              {arrival.source === 'EMAIL' ? 'Forwarded' : 'By hand'}
            </Badge>
          </div>

          <p className="text-muted-foreground text-xs">
            Arrived {new Date(arrival.arrivedAt).toLocaleString()}
          </p>

          {arrival.files.length > 0 && (
            <ul className="space-y-1 border-t pt-3">
              {arrival.files.map((file) => (
                <li key={file.id} className="text-sm">
                  <a
                    className="underline underline-offset-4"
                    href={`/ingested-document-files/${file.id}/bytes`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {file.filename}
                  </a>
                  <span className="text-muted-foreground ml-2 text-xs">
                    {file.contentType} &middot; {size(file.byteSize)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
