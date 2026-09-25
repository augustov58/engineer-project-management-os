import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { searchEveryJob, type SearchResult } from '../api';
import { SectionHead } from '../section-head';

export const dynamic = 'force-dynamic';

/** The longest query the API takes, and the box's `maxLength`. */
const LONGEST = 200;

/** What each kind is called on the page. */
const KIND: Record<SearchResult['kind'], string> = {
  project: 'Job',
  'open-item': 'Open item',
  submission: 'Submission',
  'assumption-record': 'Assumption record',
  observation: 'Observation',
  issue: 'Finding',
  'register-entry': 'Register entry',
  document: 'Document',
  arrival: 'Arrival',
  extraction: 'Extraction',
  memory: 'Project memory',
};

/**
 * Where a result opens: the one place a kind becomes a path. A record with no
 * screen of its own — an open item, a document, an arrival, the memory —
 * opens on its job, where it is listed.
 */
function hrefFor(result: SearchResult): string {
  const job = `/projects/${encodeURIComponent(result.projectId)}`;
  const id = encodeURIComponent(result.linkId);
  switch (result.kind) {
    case 'submission':
    case 'assumption-record':
      return `/submissions/${id}`;
    case 'observation':
      return `/site-visits/${id}`;
    case 'issue':
      return `${job}/issues/${id}`;
    case 'register-entry':
      return `/register-entries/${id}`;
    case 'extraction':
      return `${job}/extractions/${id}`;
    default:
      return job;
  }
}

/**
 * The excerpt with its match marked. The API brackets a match in `\u0002` and
 * `\u0003`; this splits on them and renders every piece as **text**, so an
 * arrival's body — a stranger's words — is never markup here.
 */
function Excerpt({ text }: { text: string }) {
  const pieces = text.split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <p className="text-muted-foreground text-sm">
      {pieces.map((piece, index) =>
        piece.startsWith('\u0002') ? (
          <mark key={index} className="bg-accent text-foreground rounded-sm px-0.5">
            {piece.slice(1, -1)}
          </mark>
        ) : (
          piece
        ),
      )}
    </p>
  );
}

/**
 * Keyword search across every job (issue #66, ADR-0067). The results come back
 * best first; they are grouped under their job in the order each job first
 * appears, so the best match's job leads.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = ((await searchParams).q ?? '').trim().slice(0, LONGEST);
  const found = q === '' ? [] : await searchEveryJob(q);

  const jobs = new Map<string, SearchResult[]>();
  for (const result of found) {
    jobs.set(result.projectId, [...(jobs.get(result.projectId) ?? []), result]);
  }

  return (
    <div className="max-w-[var(--measure-record)] space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Search every job</h1>
        <form action="/search" role="search" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            maxLength={LONGEST}
            aria-label="Search every job"
            placeholder="A word, a “quoted phrase”, or -word to leave out"
            className="border-input bg-background min-h-11 w-full min-w-0 rounded-md border px-3 text-base"
          />
        </form>
        {q !== '' && (
          <p className="text-muted-foreground text-sm">
            {found.length === 0
              ? `Nothing on any job matches “${q}”.`
              : `${found.length} ${found.length === 1 ? 'match' : 'matches'} for “${q}”, best first${found.length === 50 ? ' — the first fifty' : ''}.`}
          </p>
        )}
      </div>

      {[...jobs.values()].map((results) => {
        const job = results[0]!;
        return (
          <section key={job.projectId} className="space-y-3">
            <SectionHead
              aside={job.archived ? <Badge variant="secondary">Archived</Badge> : undefined}
            >
              {job.projectNumber} — {job.projectName}
            </SectionHead>
            <ul className="bg-card divide-y rounded-lg border">
              {results.map((result) => (
                <li key={`${result.kind}:${result.id}`} className="grid gap-1 px-4 py-3">
                  <p className="text-muted-foreground text-xs">{KIND[result.kind]}</p>
                  <Link href={hrefFor(result)} className="font-medium hover:underline">
                    {result.title}
                  </Link>
                  {result.excerpt !== null && <Excerpt text={result.excerpt} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
