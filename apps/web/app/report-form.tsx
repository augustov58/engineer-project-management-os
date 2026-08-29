'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { type SiteVisitReport, isRendering } from './api';

/**
 * Progress while the walk is printed, over server-sent events (issue #13).
 *
 * `CaptureProgress`'s shape, and for its reasons: the state is seeded from
 * what the server rendered and corrected by the stream afterwards, never the
 * other way round, because a value set from an effect during the hydration
 * commit is discarded (ADR-0028). When a report reaches a state the page
 * renders differently — a link to a document that now exists — this asks the
 * server for the page again.
 */
export function ReportProgress({
  siteVisitId,
  initial,
}: {
  siteVisitId: string;
  initial: SiteVisitReport[];
}) {
  const [live, setLive] = useState(initial);
  const router = useRouter();
  const rendered = useRef(summarise(initial));

  useEffect(() => {
    const source = new EventSource(`/site-visits/${siteVisitId}/reports/stream`);
    source.onmessage = (event) => {
      const reports = JSON.parse(event.data as string) as SiteVisitReport[];
      setLive(reports);

      const now = summarise(reports);
      if (now !== rendered.current) {
        rendered.current = now;
        router.refresh();
      }
    };
    return () => source.close();
  }, [siteVisitId, router]);

  if (live.length === 0) {
    return (
      <span className="text-muted-foreground text-sm">not generated yet</span>
    );
  }

  const working = live.filter(isRendering).length;

  return (
    <span className="text-muted-foreground text-sm">
      {working > 0 ? (
        <span className="text-foreground animate-pulse font-medium">
          rendering {working} of {live.length}
        </span>
      ) : (
        `${live.length} generated`
      )}
    </span>
  );
}

/** What a change to this list would change on the page. */
function summarise(reports: SiteVisitReport[]): string {
  return reports.map((one) => `${one.id}:${one.state}`).join('|');
}

/** A report's state, in the words the record uses for it. */
export function ReportState({ report }: { report: SiteVisitReport }) {
  switch (report.state) {
    case 'failed':
      return <Badge variant="destructive">Not rendered</Badge>;
    case 'rendered':
      return <Badge variant="secondary">Ready</Badge>;
    case 'rendering':
      return <Badge variant="outline">Rendering</Badge>;
    default:
      return <Badge variant="outline">Queued</Badge>;
  }
}
