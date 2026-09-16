import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import {
  requestExtractionFromChosenDocument,
  requestExtractionFromDocument,
} from '../app/actions';
import { ExtractFromDocumentForm } from '../app/extract-button';
import ExtractionPage from '../app/projects/[id]/extractions/[extractionId]/page';
import RegisterLog from '../app/registers/[id]/page';

/**
 * Extraction is reachable from where the document is (issue #108).
 *
 * The capability was complete and unreachable: the ask existed on the
 * Documents section and nowhere else, and it left the engineer on the project
 * screen to find the proposal under Extractions — four steps across three
 * screens, none of them the one you are on when you decide to log an RFI
 * (issue #100). So two claims are asserted here and neither is about what the
 * agent reads: that the register screen offers the ask at all, and that the
 * ask lands on the confirmation screen that already exists.
 *
 * The refusal has its own test because it is the one answer the screen must
 * not swallow: on a job whose processing location is local, ADR-0044's gate
 * firing correctly used to arrive as Next's error screen, and a gate that
 * looks like a crash is one the engineer learns to distrust (issue #67).
 */

const nav = vi.hoisted(() => ({ redirected: vi.fn<(to: string) => void>() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  // What `redirect` does in Next: it throws, so nothing after it runs. A test
  // that let it return would pass on an action that redirected and then
  // carried on.
  redirect: (to: string) => {
    nav.redirected(to);
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock('../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    apiFetch: vi.fn(),
    getExtraction: vi.fn(),
    getProject: vi.fn(),
    getRegister: vi.fn(),
    listExtractionTargets: vi.fn(),
    // Who a handoff into our court may name, and who it defaults to
    // (issue #112). Both screens under test carry a handoff.
    listUsers: vi.fn(),
    currentUser: vi.fn(),
  };
});

const engineer: api.User = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
};

const project: api.Project = {
  id: 'project-1',
  projectNumber: '260001',
  name: 'A live job',
  createdAt: '2026-09-01T09:00:00.000Z',
  timezone: 'America/New_York',
  archivedAt: null,
  currentPhaseId: null,
  ingestAddress: null,
  processingLocation: 'CLOUD',
  cloudSignoffReference: null,
  cloudSignoffAt: null,
};

const register: api.Register = {
  id: 'register-1',
  projectId: project.id,
  kind: 'RFI',
  createdAt: '2026-09-01T09:00:00.000Z',
  entries: [],
};

/** A document with two revisions: the later one is what the API will read. */
const document: api.StoredDocument = {
  id: 'document-1',
  projectId: project.id,
  title: 'Panel schedule',
  referencedFile: false,
  createdAt: '2026-09-02T09:00:00.000Z',
  versions: [
    {
      id: 'version-c',
      documentId: 'document-1',
      revision: 'C',
      filename: 'panel-schedule-c.pdf',
      contentType: 'application/pdf',
      byteSize: 12_000,
      createdAt: '2026-09-02T09:00:00.000Z',
    },
    {
      id: 'version-d',
      documentId: 'document-1',
      revision: 'D',
      filename: 'panel-schedule-d.pdf',
      contentType: 'application/pdf',
      byteSize: 13_000,
      createdAt: '2026-09-03T09:00:00.000Z',
    },
  ],
};

/** The API's own sentence for an ask whose run is already going. */
const alreadyGoing = 'an extraction of that document is already in flight';

/** An answer from the one module that reaches the API. */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.mocked(api.getProject).mockResolvedValue(project);
  vi.mocked(api.getRegister).mockResolvedValue(register);
  vi.mocked(api.listExtractionTargets).mockResolvedValue([document]);
  vi.mocked(api.listUsers).mockResolvedValue([engineer]);
  vi.mocked(api.currentUser).mockResolvedValue(engineer);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function registerScreen() {
  render(await RegisterLog({ params: Promise.resolve({ id: register.id }) }));
}

test('the RFIs register screen offers extraction over a stored document', async () => {
  await registerScreen();

  const control = screen.getByLabelText(/build one from a document/i);
  // Native, as every select in this product is (ADR-0025) — the action reads
  // this value straight out of `FormData`.
  expect(control.tagName).toBe('SELECT');

  // The document is what is chosen and the revision is what is named: the API
  // resolves the latest version itself, so a select of versions would let the
  // engineer pick C and silently extract D.
  const offered = [...control.querySelectorAll('option')].map(
    (option) => option.textContent,
  );
  expect(offered).toContain('Panel schedule — revision D');
  expect(
    (control.querySelector('option[value="document-1"]') as HTMLOptionElement)
      .textContent,
  ).toContain('revision D');

  expect(screen.getByRole('button', { name: 'Extract' })).toBeDefined();
});

test('a job with nothing extraction could be pointed at offers no control', async () => {
  vi.mocked(api.listExtractionTargets).mockResolvedValue([]);

  await registerScreen();

  expect(screen.queryByLabelText(/build one from a document/i)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Extract' })).toBeNull();
});

test('the refusal is shown in place rather than thrown', async () => {
  const refusal =
    "this job's documents are processed locally, so nothing is sent to a third party";
  const request = vi.fn(async () => refusal);

  render(<ExtractFromDocumentForm documents={[document]} request={request} />);
  fireEvent.submit(screen.getByRole('button', { name: 'Extract' }).closest('form') as HTMLFormElement);

  const said = await screen.findByRole('alert');
  expect(said.textContent).toBe(refusal);
});

test('asking lands on the confirmation screen that already exists', async () => {
  vi.mocked(api.apiFetch).mockResolvedValue(
    answer(201, { id: 'extraction-1', state: 'queued' }),
  );

  await expect(
    requestExtractionFromDocument(project.id, document.id, undefined),
  ).rejects.toThrow('redirect:/projects/project-1/extractions/extraction-1');

  expect(nav.redirected).toHaveBeenCalledWith(
    '/projects/project-1/extractions/extraction-1',
  );
});

test('an ask already in flight is swallowed where the screen shows the truth', async () => {
  // The second half of a double click on the Documents section, which sits
  // above the project screen's live extraction list. There is no row of this
  // ask's own to land on, and the re-render says what is actually happening.
  vi.mocked(api.apiFetch).mockResolvedValue(
    answer(409, { message: alreadyGoing }),
  );

  await expect(
    requestExtractionFromDocument(project.id, document.id, undefined),
  ).resolves.toBeUndefined();
  expect(nav.redirected).not.toHaveBeenCalled();
});

test('and is said aloud from the register screen, which shows nothing', async () => {
  // The same 409 from a screen carrying no extraction list, which this ask
  // also redirects away from: swallowed here it is a click that changes
  // nothing on the page at all. Not only a double click — the targets read
  // excludes a referenced file and nothing else, so a document whose run is
  // already going is still in the select.
  vi.mocked(api.apiFetch).mockResolvedValue(
    answer(409, { message: alreadyGoing }),
  );

  const picked = new FormData();
  picked.set('documentId', document.id);

  await expect(
    requestExtractionFromChosenDocument(project.id, undefined, picked),
  ).resolves.toBe(alreadyGoing);
  expect(nav.redirected).not.toHaveBeenCalled();
});

test('the register screen refuses an ask with no document picked', async () => {
  await expect(
    requestExtractionFromChosenDocument(project.id, undefined, new FormData()),
  ).resolves.toBe('pick a document first');
  expect(vi.mocked(api.apiFetch)).not.toHaveBeenCalled();
});

/**
 * The extraction the ask lands on, in a state that has nothing to confirm.
 *
 * The source is a document version, which is the path both entry points here
 * take; the mail path is the other screen's and unchanged by this issue.
 */
function asked(state: api.Extraction['state']): api.ExtractionDetail {
  return {
    id: 'extraction-1',
    projectId: project.id,
    ingestedDocumentFileId: null,
    documentVersionId: 'version-d',
    runningSince: null,
    finishedAt: null,
    failedAt: null,
    failure: 'no OCR provider is configured',
    proposedKind: null,
    proposedAt: null,
    proposedNumber: null,
    proposedSubject: null,
    proposedFromParty: null,
    proposedToParty: null,
    proposedQuestion: null,
    proposedResponse: null,
    proposedTurnaroundDays: null,
    proposedParty: null,
    proposedInOurCourt: null,
    proposedHeldSince: null,
    proposedTitle: null,
    proposedRevision: null,
    confirmedAt: null,
    registerEntryId: null,
    rejectedAt: null,
    createdAt: '2026-09-13T09:00:00.000Z',
    source: {
      filename: 'panel-schedule-d.pdf',
      document: { id: document.id, title: document.title },
    },
    ocrText: null,
    state,
  };
}

/** Every stream this render opened, over the setup file's silent stub. */
function streams(): string[] {
  const opened: string[] = [];
  class Recorder {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string) {
      opened.push(url);
    }
    close(): void {}
  }
  vi.stubGlobal('EventSource', Recorder);
  return opened;
}

async function confirmationScreen(state: api.Extraction['state']) {
  vi.mocked(api.getExtraction).mockResolvedValue(asked(state));
  render(
    await ExtractionPage({
      params: Promise.resolve({
        id: project.id,
        extractionId: 'extraction-1',
      }),
    }),
  );
}

test('the screen the ask lands on says the run has not read anything yet', async () => {
  await confirmationScreen('queued');

  // Not "this extraction has not proposed anything to review", which covered
  // queued, reading and read-with-nothing-to-propose alike and read as a
  // refusal on the two the ask now lands on.
  expect(
    screen.getByText(/Queued\. Nothing has been read yet/),
  ).toBeDefined();
});

test('a run that can still move is watched, and a resolved one is not', async () => {
  const opened = streams();

  await confirmationScreen('running');
  expect(opened).toEqual([
    `/projects/${project.id}/extractions/stream`,
  ]);

  cleanup();
  opened.length = 0;

  // Nothing left to watch: a failed run is where it will stay, and a stream
  // opened on it is a connection held for an answer that never comes.
  await confirmationScreen('failed');
  expect(screen.getByText(/no OCR provider is configured/)).toBeDefined();
  expect(opened).toEqual([]);

  vi.unstubAllGlobals();
});

test('every other refusal comes back as the API said it', async () => {
  vi.mocked(api.apiFetch).mockResolvedValue(
    answer(409, { message: 'a referenced file is not an extraction target' }),
  );

  await expect(
    requestExtractionFromDocument(project.id, document.id, undefined),
  ).resolves.toBe('a referenced file is not an extraction target');
  expect(nav.redirected).not.toHaveBeenCalled();
});
