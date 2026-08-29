'use client';

import { Badge } from '@/components/ui/badge';
import { type SiteVisitReport, isRendering } from './api';
import { useLiveList } from './live-list';

/**
 * Progress while the walk is printed, over server-sent events (issue #13).
 *
 * The state the page renders differently is a document that now exists, and
 * the link to it is server-rendered — so a refresh is what puts it on screen.
 */
export function ReportProgress({
  siteVisitId,
  initial,
}: {
  siteVisitId: string;
  initial: SiteVisitReport[];
}) {
  const live = useLiveList(
    `/site-visits/${siteVisitId}/reports/stream`,
    initial,
    summarise,
  );

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
