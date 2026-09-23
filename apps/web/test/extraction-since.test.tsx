import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import { confirmExtraction } from '../app/actions';
import { ExtractionConfirmForm } from '../app/extractions';

/**
 * A proposed Since is the date on the document, on either side of UTC
 * (issue #154).
 *
 * The model reads a date off a letter and was asked for an instant, so it
 * wrote midnight UTC — and the screen read that instant in the job's zone, as
 * ADR-0054 says an instant is read, which west of UTC is the evening before.
 * The proposal is a date now, and a date has no zone to be read in.
 *
 * The two sides here are in different frames, which is ADR-0052's rule for a
 * comparison across one: the proposal is the document's, and the instant the
 * confirmation sends is composed in the job's zone and read back through ICU
 * here, never through `wall-clock.ts`, which is the code under test.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock('../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return { ...actual, apiFetch: vi.fn(), getProject: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DATED = '2026-09-22';

const engineer: api.User = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
};

function project(timezone: string): api.Project {
  return {
    id: 'project-1',
    projectNumber: '260001',
    name: 'A live job',
    createdAt: '2026-09-01T09:00:00.000Z',
    timezone,
    archivedAt: null,
    currentPhaseId: null,
    ingestAddress: null,
    processingLocation: 'CLOUD',
    cloudSignoffReference: null,
    cloudSignoffAt: null,
  };
}

/** A proposal read off a document dated `DATED`, from a stored version. */
const proposed: api.ExtractionDetail = {
  id: 'extraction-1',
  projectId: 'project-1',
  ingestedDocumentFileId: null,
  documentVersionId: 'version-1',
  runningSince: '2026-09-22T13:00:00.000Z',
  finishedAt: '2026-09-22T13:00:30.000Z',
  failedAt: null,
  failure: null,
  proposedKind: 'RFI',
  proposedAt: '2026-09-22T13:00:20.000Z',
  proposedNumber: 'RFI-017',
  proposedSubject: 'Baseplate detail',
  proposedFromParty: 'Acme Mechanical',
  proposedToParty: 'the engineer',
  proposedQuestion: 'which detail governs?',
  proposedResponse: null,
  proposedTurnaroundDays: null,
  proposedParty: 'the engineer',
  proposedInOurCourt: true,
  proposedHeldSince: DATED,
  proposedTitle: null,
  proposedRevision: null,
  confirmedAt: null,
  registerEntryId: null,
  rejectedAt: null,
  createdAt: '2026-09-22T13:00:00.000Z',
  source: {
    filename: 'rfi-017.pdf',
    document: { id: 'document-1', title: 'RFI-017' },
  },
  ocrText: 'RFI-017, dated 22 September 2026',
  state: 'pending',
};

/** The day and clock time an instant reads in a zone, from ICU alone. */
function wallIn(instant: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

for (const timeZone of ['America/Los_Angeles', 'Asia/Tokyo']) {
  test(`a document dated ${DATED} pre-fills Since as ${DATED}, and confirms as that day, in ${timeZone}`, async () => {
    const { container } = render(
      <ExtractionConfirmForm
        projectId="project-1"
        extraction={proposed}
        timeZone={timeZone}
        users={[engineer]}
        me={engineer.id}
      />,
    );

    const since = screen.getByLabelText('Since') as HTMLInputElement;
    expect(since.value).toBe(DATED);

    // What the pre-filled form sends, untouched: midnight of that day where
    // the building is.
    vi.mocked(api.getProject).mockResolvedValue(project(timeZone));
    vi.mocked(api.apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ registerEntryId: 'entry-1' }), { status: 201 }),
    );
    const form = container.querySelector('form')!;
    await expect(
      confirmExtraction('project-1', 'extraction-1', false, { added: 0 }, new FormData(form)),
    ).rejects.toThrow('redirect:/register-entries/entry-1');

    const [, init] = vi.mocked(api.apiFetch).mock.calls[0]!;
    const sent = JSON.parse(String(init?.body)) as {
      ballInCourt: { heldSince: string };
    };
    expect(wallIn(sent.ballInCourt.heldSince, timeZone)).toBe(`${DATED} 00:00`);
  });
}
