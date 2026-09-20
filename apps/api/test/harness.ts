import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { inject } from 'vitest';
import type { AgentRunService } from '../src/agent.js';
import { SESSION_HEADER, SESSION_LIFETIME_MS, newSessionId } from '../src/gate.js';
import type { OcrProvider } from '../src/ocr.js';
import { hashPassword } from '../src/passwords.js';
import { createRuntime } from '../src/runtime.js';
import {
  type InboundMailProvider,
  stubInboundMailProvider,
} from '../src/inbound-mail.js';
import { buildServer } from '../src/server.js';
import { systemTimeSource, type TimeSource } from '../src/time-source.js';
import type { Transcriber } from '../src/transcription.js';
import { buildWorker } from '../src/worker.js';

/**
 * The account every test is signed in as (issue #105, ADR-0055).
 *
 * Fixed rather than generated, for the reason the shared secret it replaces
 * was: what a test asserts about the gate is that a live session opens it and
 * nothing else does, and a value that changed per run would make a failing
 * case harder to read for no gain. The password is long enough to satisfy the
 * one rule there is, and is a credential for a database that exists for the
 * length of one test file.
 */
export const TEST_USER = {
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  password: 'analytical-engine-1843',
} as const;

export interface TestApi {
  /** Origin of a real listening HTTP server, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /**
   * `fetch` against this API, signed in as `TEST_USER`. Tests assert on the
   * response, nothing else.
   *
   * Every test goes through the gate rather than around it, because that is
   * what a deployment does. A test *about* the gate uses `baseUrl` with the
   * global `fetch` instead, which is the only way to be an anonymous caller.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The account those calls are made as, and the session they present. */
  user: { id: string; name: string; email: string };
  sessionId: string;
  /**
   * Every route Fastify actually registered, method and path.
   *
   * Collected rather than written down, so the gate's sweep covers a route
   * added later without anybody remembering to add it there (ADR-0020).
   */
  routes(): { method: string; url: string }[];
  /**
   * The tables the migrations actually produced.
   *
   * The one sanctioned way past the HTTP boundary, because which tables the
   * migrations produced — `users` and `sessions` present, `roles`,
   * `permissions` and `tenants` absent (ADR-0055) — is a schema invariant no
   * route can ever expose. It
   * returns names and nothing else, so it cannot be used to read domain data
   * or to write a row — which is what the "fixtures through the API" rule is
   * protecting.
   */
  tableNames(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * Boots the API over its own freshly migrated PostgreSQL database and a real
 * Redis, and listens on a random port.
 *
 * Every call copies the migrated template database, so tests never share
 * state and never need to clean up after each other. Two things are
 * substituted, and both are seams the plan names: the time source, and the
 * transcription vendor — the one place issue #12 leaves this process for
 * something no test may depend on.
 *
 * The transcription **worker** is not substituted. It is the real BullMQ
 * worker over the real Redis the containers already start, built from the
 * same `buildWorker` production calls, so a queued job is genuinely queued
 * and genuinely picked up.
 */
export async function startTestApi(
  options: {
    timeSource?: TimeSource;
    transcriber?: Transcriber;
    /**
     * The agent, for the memory runs (issue #18). Substituted the way the
     * transcription vendor is: it is the one other place the system leaves
     * the process for a paid call no test may depend on. The default is
     * `fakeAgentRunService`, which proposes one fixed line through the real
     * internal route the genuine adapter's tool calls.
     */
    agentRunService?: AgentRunService;
    /**
     * Whether to run the worker at all. Default true.
     *
     * `false` does not substitute it — it does not start one, which is a state
     * production has too: the API up with a job still sitting in Redis, which
     * is what `POST /voice-captures/:id/retry` exists for. It is how *queued*
     * becomes a state a test can stand in and look at for work with no vendor
     * seam to hold open, the way `heldTranscriber` does for a transcription.
     */
    worker?: boolean;
    /**
     * How an inbound webhook payload is read (issue #19).
     *
     * Defaults to the stub, as the transcriber defaults to a working fake —
     * a test that wants the refusal passes `unconfiguredInboundMailProvider`
     * the way one wanting a failed transcription passes `refusingTranscriber`.
     * Production defaults the other way: no adapter is written (ADR-0042).
     */
    inboundMail?: InboundMailProvider;
    /**
     * The OCR vendor, for the extraction runs (issue #20). Substituted the
     * way the transcription vendor is: it is one of the two places the
     * extraction pipeline leaves the process. The default is
     * `fakeOcrProvider`, which answers one fixed page; a test that wants the
     * honest failure passes `refusingOcrProvider` — or the real
     * `unconfiguredOcrProvider`, which is the production default (ADR-0043).
     */
    ocr?: OcrProvider;
    /**
     * The public half of an ingest address. `null` configures none, which is
     * how the "no address is offered" state becomes one a test can look at.
     */
    ingestDomain?: string | null;
  } = {},
): Promise<TestApi> {
  const adminUrl = inject('postgresAdminUrl');
  const database = `test_${randomBytes(8).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(
    `CREATE DATABASE "${database}" TEMPLATE "${inject('templateDatabase')}"`,
  );
  await admin.end();

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;

  // A directory of its own, so one test's photographs are invisible to the
  // next exactly as one test's rows are. Removed with the database below.
  const objectStoreDir = await mkdtemp(join(tmpdir(), 'epmos-objects-'));

  const runtime = createRuntime({
    databaseUrl: databaseUrl.toString(),
    redisUrl: inject('redisUrl'),
    queueName: `test-${database}`,
    objectStoreDir,
  });

  const ingestDomain =
    options.ingestDomain === undefined ? 'ingest.test' : options.ingestDomain;

  const app = buildServer({
    prisma: runtime.prisma,
    queue: runtime.queue,
    objectStore: runtime.objectStore,
    timeSource: options.timeSource,
    inboundMail: options.inboundMail ?? stubInboundMailProvider,
    ...(ingestDomain === null ? {} : { ingestDomain }),
  });

  // Added before `ready`, and the routes above are registered *at* `ready`
  // inside an encapsulated context — a root `onRoute` hook sees every one of
  // them, including the HEAD routes Fastify derives from the GETs.
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      routes.push({ method, url: route.url });
    }
  });

  const worker =
    options.worker === false
      ? null
      : buildWorker({
          prisma: runtime.prisma,
          objectStore: runtime.objectStore,
          transcriber: options.transcriber ?? fakeTranscriber(),
          agentRunService: options.agentRunService ?? fakeAgentRunService(app),
          ocr: options.ocr ?? fakeOcrProvider(),
          // The same default `buildServer` applies, spelled here because the
          // worker has no boundary of its own to default at.
          timeSource: options.timeSource ?? systemTimeSource,
          connection: runtime.workerConnection,
          queueName: runtime.queueName,
        });

  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the test API to be listening on a TCP port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  /**
   * The first account and one session for it, written directly.
   *
   * The **one** place this harness writes rows rather than building a fixture
   * through the API, and it is the bootstrap rather than an exception to the
   * rule: on a real deployment the first account is made by a command on the
   * machine before anything can sign in, and there is no route that could make
   * it (ADR-0055 part 7). Both the create route and the sign-in route are
   * driven over HTTP like everything else, by `users.test.ts` and
   * `sessions.test.ts`.
   *
   * No audit line: signing in through the route would write one into every
   * test's database, and `export.test.ts` asserts that an untouched database
   * has nothing in `audit_entries`.
   *
   * And it **outlives any clock a test advances**, unlike the year a real
   * sign-in gets: a dozen suites age a fake TimeSource by days or by four
   * hundred of them to watch something get old, and a fixture that expired
   * under them would turn every one of those into a 401 about the wrong thing.
   * What a real session's life is worth is asserted against one minted by the
   * route, in `sessions.test.ts` and `gate.test.ts`.
   */
  // Through the port, and spelled with the default the way the worker's is
  // above: the boundary is what defaults a `TimeSource`, and a bootstrap that
  // read the wall clock directly would be the one persisted timestamp in this
  // product that did not come from one (ADR-0022).
  const now = (options.timeSource ?? systemTimeSource).now();
  const user = await runtime.prisma.user.create({
    data: {
      name: TEST_USER.name,
      email: TEST_USER.email,
      passwordHash: await hashPassword(TEST_USER.password),
      createdAt: now,
    },
    select: { id: true, name: true, email: true },
  });
  const session = await runtime.prisma.session.create({
    data: {
      id: newSessionId(),
      userId: user.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 100 * SESSION_LIFETIME_MS),
    },
    select: { id: true },
  });

  return {
    baseUrl,
    user,
    sessionId: session.id,
    fetch: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set(SESSION_HEADER, session.id);
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },
    // A copy: a caller sweeping this must not be able to edit what it swept.
    routes: () => [...routes],
    tableNames: async () => {
      const rows = await runtime.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `;
      return rows.map((row) => row.table_name);
    },
    close: async () => {
      await app.close();
      // Forced, unlike production's. A test that holds the fake vendor open to
      // look at *transcribing* has a job that will never finish on its own,
      // and a graceful close waits for exactly that.
      await worker?.close(true);
      await runtime.close();
      await rm(objectStoreDir, { recursive: true, force: true });

      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** A time source the test moves by hand, so aging is tested without sleeping. */
export function fakeTimeSource(start: Date) {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

/** A project as the API returns it. */
export interface ProjectResponse {
  id: string;
  projectNumber: string;
  name: string;
  createdAt: string;
  /** The zone of the building, and the frame every time on the job is read in. */
  timezone: string;
  archivedAt: string | null;
  /** Composed from the token and the domain; null when none is configured. */
  ingestAddress: string | null;
  /** Where this job's documents are read (issue #21). Cloud by default. */
  processingLocation: 'LOCAL' | 'CLOUD';
  cloudSignoffReference: string | null;
  cloudSignoffAt: string | null;
}

/**
 * Fixtures are built through the API, never by writing to the database.
 *
 * The zone defaults **here and not in the product** (ADR-0054): the route
 * requires one with no default, and `projects.test.ts` asserts that it does.
 * A fixture that named a zone at all 257 call sites would say nothing extra
 * about a job whose times no assertion reads in a second zone.
 */
export async function createProject(
  api: TestApi,
  projectNumber: string,
  name: string,
  timezone = 'America/New_York',
): Promise<ProjectResponse> {
  const response = await api.fetch('/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectNumber, name, timezone }),
  });
  if (response.status !== 201) {
    throw new Error(
      `fixture failed: POST /v1/projects returned ${response.status}`,
    );
  }
  return (await response.json()) as ProjectResponse;
}

/**
 * A person, as every record that names one returns them (issues #105, #112).
 *
 * Three records name one on the wire — a walk's **conducted by**, an open
 * item's **owner**, a handoff's **user** — and all three come back in this
 * shape, because one projection composes all of them. The hash is not on it
 * and neither is `disabledAt`.
 */
export interface UserResponse {
  id: string;
  name: string;
  email: string;
}

/**
 * A second account, made through the route (issues #105, #112).
 *
 * Through `POST /v1/users` and not by writing a row: the harness's own
 * bootstrap is the one direct write there is, and a *second* person is an
 * ordinary audited mutation by somebody already signed in.
 */
export async function createUser(
  api: TestApi,
  name: string,
  email: string,
  password = 'a-second-analytical-engine',
): Promise<UserResponse> {
  const response = await api.fetch('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST /v1/users returned ${response.status}`);
  }
  return (await response.json()) as UserResponse;
}

/** An open item as the API returns it. */
export interface OpenItemResponse {
  id: string;
  subjectType: 'PROJECT';
  subjectId: string;
  unresolved: string;
  blocks: string;
  waitingOn: string | null;
  waitingSince: string;
  invalidationTrigger: string | null;
  counterfactual: string;
  /** The person it sits with (issue #112). Never the raw `owner_id`. */
  owner: UserResponse;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface OpenItemBody {
  unresolved: string;
  blocks: string;
  waitingOn: string | null;
  counterfactual: string;
  waitingSince?: string;
  invalidationTrigger?: string;
}

/**
 * A valid create body, so a test that is about one field does not have to
 * restate the other three that are required.
 *
 * Patching a field to `undefined` leaves it off the wire entirely rather than
 * sending a null, which is how a test says "this field was not supplied".
 *
 * The patch is untyped rather than `Partial<OpenItemBody>`, as `handoffBody`'s
 * is and for its reason: one case sends an `owner`, which stopped being a
 * field in issue #112 and is exactly the body the boundary exists to refuse.
 */
export function openItemBody(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    unresolved: 'Ceiling height at the north stair',
    blocks: 'Sizing the main run',
    waitingOn: 'Contractor',
    counterfactual: 'If the height is lower the run has to be rerouted',
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createOpenItem(
  api: TestApi,
  projectId: string,
  patch: Partial<OpenItemBody> = {},
): Promise<OpenItemResponse> {
  const path = `/v1/projects/${projectId}/open-items`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(openItemBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as OpenItemResponse;
}

/** A phase as the API returns it. */
export interface PhaseResponse {
  id: string;
  projectId: string;
  name: string;
  position: number;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createPhase(
  api: TestApi,
  projectId: string,
  name: string,
): Promise<PhaseResponse> {
  const path = `/v1/projects/${projectId}/phases`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as PhaseResponse;
}

/** A submission as the API returns it from a create or a list. */
export interface SubmissionResponse {
  id: string;
  projectId: string;
  phaseId: string;
  issuedAt: string;
  recipient: string;
  recipientRole: string;
  revision: string;
  sheetList: string;
  createdAt: string;
  /** Stamped at issuance and never recomputed (issue #6). */
  issuedProvisional: boolean;
  /** Derived from live open items on every read, never stored (issue #6). */
  currentlyProvisional: boolean;
  /** The issuance this one replaced, or null if it replaced nothing (issue #7). */
  supersedesId: string | null;
  /** The issuance that replaced this one. Derived, never stored (issue #7). */
  supersededById: string | null;
}

/**
 * One issuance as its own supersede chain lists it. Enough to tell the sets
 * in a lineage apart and to say which one is the current issuance.
 */
export interface ChainEntry {
  id: string;
  revision: string;
  issuedAt: string;
  recipient: string;
  recipientRole: string;
  issuedProvisional: boolean;
  supersedesId: string | null;
  /** The last link: what is actually out there now. */
  current: boolean;
}

/**
 * An open item as it reads on a submission resting on it: the item plus where
 * it stood at the moment that set went out. Null is an item attached
 * afterwards, which was no part of the issuance.
 */
export interface RestsOnResponse extends OpenItemResponse {
  unresolvedAtIssuance: boolean | null;
}

/**
 * One submission read on its own, which is the only place the things it hangs
 * off are resolved: the phase it was issued at, the job it belongs to, and
 * what it rests on.
 */
export interface SubmissionDetail extends SubmissionResponse {
  phase: PhaseResponse;
  project: { id: string; projectNumber: string; name: string };
  openItems: RestsOnResponse[];
  /** The whole lineage, oldest issuance first, read from any set in it. */
  chain: ChainEntry[];
}

/** A currently provisional submission as the exposure view returns it. */
export interface ExposureRow extends SubmissionResponse {
  phase: PhaseResponse;
  project: { id: string; projectNumber: string; name: string };
}

export interface SubmissionBody {
  recipient: string;
  recipientRole: string;
  revision: string;
  sheetList: string;
  phaseId?: string;
  issuedAt?: string;
  openItemIds?: string[];
}

/**
 * A valid create body, so a test about one field does not have to restate the
 * other three. Patching a field to `undefined` leaves it off the wire rather
 * than sending a null, which is how a test says "not supplied".
 */
export function submissionBody(
  patch: Partial<SubmissionBody> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    recipient: 'Wren Alcott',
    recipientRole: 'EOR',
    revision: 'Rev 1',
    sheetList: 'E0.01\nE1.01\nE2.01',
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createSubmission(
  api: TestApi,
  projectId: string,
  patch: Partial<SubmissionBody> = {},
): Promise<SubmissionResponse> {
  const path = `/v1/projects/${projectId}/submissions`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submissionBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as SubmissionResponse;
}

/**
 * Fixtures are built through the API, never by writing to the database.
 *
 * Leaving `openItemIds` off is not the same as passing an empty array: the
 * first carries the predecessor's items forward, the second drops them on
 * purpose (issue #7).
 */
export async function reissueSubmission(
  api: TestApi,
  submissionId: string,
  patch: Partial<SubmissionBody> = {},
): Promise<SubmissionResponse> {
  const path = `/v1/submissions/${submissionId}/reissue`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submissionBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as SubmissionResponse;
}

/**
 * One line of a captured block, as the API returns it: the verbatim text and
 * the number it is addressed by. Split from the block on every read and stored
 * nowhere, so a line and the block it came from cannot disagree.
 */
export interface AssumptionLine {
  line: number;
  text: string;
  /** What changes if this input turns out wrong. Null until one is written. */
  counterfactual: string | null;
}

export interface FlagLine {
  line: number;
  text: string;
  /** The item this flag was raised as, or null while it is still outstanding. */
  openItem: OpenItemResponse | null;
}

/** An assumption record as the API returns it. */
export interface AssumptionRecordResponse {
  id: string;
  submissionId: string;
  /** Verbatim, and byte-for-byte what was captured. */
  assumptions: string;
  flags: string;
  codeEdition: string;
  calculatedAt: string;
  createdAt: string;
  /** The agent's turn this was confirmed from, or null on a paste (#121). */
  turnId: string | null;
  assumptionLines: AssumptionLine[];
  flagLines: FlagLine[];
}

export interface AssumptionRecordBody {
  assumptions: string;
  flags: string;
  codeEdition: string;
  calculatedAt?: string;
  /** The turn this was proposed on, when it was proposed at all (#121). */
  turnId?: string;
}

/**
 * A valid capture body. The blocks are real output from the transformer sizer
 * — two-space indent, `- ` and `! ` sigils, a non-ASCII character — because a
 * test about capturing something verbatim should capture the thing.
 */
export function assumptionRecordBody(
  patch: Partial<AssumptionRecordBody> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    assumptions: [
      'ASSUMPTIONS:',
      '  - No extra spare (--spare 0): demand 65.0 kVA -> next std 75 kVA',
      '  - Secondary OCPD present',
      '  - SDS: Δ-Y carries no supply neutral into the secondary, so it is separately derived (250.30 applies).',
    ].join('\n'),
    flags: [
      'FLAGS / VERIFY:',
      '  ! 125% sec FLA wants 300A but the downstream panel bus is 225A.',
      '  ! Electrode type not given (--electrode): the full Table 250.66 GEC is shown.',
    ].join('\n'),
    codeEdition: 'NEC 2023',
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createAssumptionRecord(
  api: TestApi,
  submissionId: string,
  patch: Partial<AssumptionRecordBody> = {},
): Promise<AssumptionRecordResponse> {
  const path = `/v1/submissions/${submissionId}/assumption-records`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(assumptionRecordBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as AssumptionRecordResponse;
}

/** A site visit as the API returns it. */
export interface SiteVisitResponse {
  id: string;
  projectId: string;
  startedAt: string;
  /** Null while the walk is still under way. */
  endedAt: string | null;
  createdAt: string;
  /**
   * The day of `startedAt`, derived on every read and stored nowhere. A visit
   * is "one dated observation event", and this is that date.
   */
  visitedOn: string;
  /** Who walked it (issue #112). Never the raw `conducted_by`. */
  conductedBy: UserResponse;
}

/** One floor's window in time, as the API returns it. */
export interface SiteVisitFloorResponse {
  id: string;
  siteVisitId: string;
  floor: string;
  startedAt: string;
  /** Null while the floor is still being walked. */
  completedAt: string | null;
}

/** An observation as the API returns it. */
export interface ObservationResponse {
  id: string;
  siteVisitId: string;
  /** What was observed. Not a *note*: this is the thing itself. */
  observed: string;
  observedAt: string;
  floor: string;
  qualifier: string;
  /** Exactly one of these is set; the other is null. */
  side: string | null;
  sector: string | null;
  createdAt: string;
  /**
   * The composed grammar string, rendered from the components on every read
   * and stored nowhere: `Floor N — <qualifier>, <Side|Sector>`.
   */
  location: string;
}

/** One site visit read on its own, with its schedule and what it produced. */
export interface SiteVisitDetail extends SiteVisitResponse {
  project: { id: string; projectNumber: string; name: string };
  floors: SiteVisitFloorResponse[];
  observations: ObservationResponse[];
  /** In the order they were taken, which is the order the walk happened in. */
  photos: PhotoResponse[];
  /** The walk's conversation, with its turns in order (issue #114). */
  conversation: ConversationResponse;
  /** The write-ups asked for of this walk, oldest first (issue #13). */
  reports: SiteVisitReportResponse[];
}

export interface SiteVisitBody {
  startedAt?: string;
  endedAt?: string;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createSiteVisit(
  api: TestApi,
  projectId: string,
  patch: Partial<SiteVisitBody> = {},
): Promise<SiteVisitResponse> {
  const path = `/v1/projects/${projectId}/site-visits`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as SiteVisitResponse;
}

export interface ObservationBody {
  observed: string;
  floor: string;
  qualifier: string;
  observedAt?: string;
  side?: string;
  sector?: string;
}

/**
 * A valid create body, so a test about one field does not have to restate the
 * other three. Patching a field to `undefined` leaves it off the wire rather
 * than sending a null, which is how a test says "not supplied" — and for the
 * two axes that is the whole distinction being tested.
 */
export function observationBody(
  patch: Partial<ObservationBody> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    observed: 'Fire-rated wall penetration left unsealed above the ceiling',
    floor: '3',
    qualifier: 'Stair B',
    side: 'A',
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createObservation(
  api: TestApi,
  siteVisitId: string,
  patch: Partial<ObservationBody> = {},
): Promise<ObservationResponse> {
  const path = `/v1/site-visits/${siteVisitId}/observations`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(observationBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as ObservationResponse;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function startFloor(
  api: TestApi,
  siteVisitId: string,
  floor: string,
  startedAt?: string,
): Promise<SiteVisitFloorResponse> {
  const path = `/v1/site-visits/${siteVisitId}/floors`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(startedAt === undefined ? { floor } : { floor, startedAt }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as SiteVisitFloorResponse;
}

/** One sighting of a finding, as an issue lists it: the observation and its walk. */
export interface IssueObservationResponse extends ObservationResponse {
  siteVisit: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    visitedOn: string;
  };
}

/** An issue as the API returns it. */
export interface IssueResponse {
  id: string;
  projectId: string;
  /**
   * The stable identifier, scoped to the project. Allocated once, never
   * reused and never renumbered, so a reference printed in an issued report
   * stays valid forever.
   */
  number: number;
  /** One of exactly five, in the words the glossary writes them. */
  category: string;
  /** Both null while the issue is open; both set once it is closed. */
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
  /**
   * Every sighting, oldest first — the observation it was raised from and
   * every re-observation since. This list is the history; there is no
   * per-visit state beside it.
   */
  observations: IssueObservationResponse[];
  /** What is being chased for this finding, oldest first. */
  openItems: OpenItemResponse[];
  /**
   * The photo evidence for this finding, across every walk — **derived**
   * (issue #113, ADR-0056): the photographs stamped to it, union the
   * photographs of its sightings. Nothing is written here by promotion.
   */
  photos: PhotoResponse[];
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createIssue(
  api: TestApi,
  observationId: string,
  category = 'Physical / Safety',
): Promise<IssueResponse> {
  const path = `/v1/observations/${observationId}/issue`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as IssueResponse;
}

/** A photograph as the API returns it. Never its bytes. */
export interface PhotoResponse {
  id: string;
  siteVisitId: string;
  /** The name it arrived with, kept verbatim. It is the mechanism. */
  filename: string;
  takenAt: string;
  contentType: string;
  byteSize: number;
  /**
   * The floor its timestamp binned it to, or null when no single window
   * contained it — outside every one, or inside two at once.
   */
  floor: string | null;
  /**
   * The finding its filename bound it to, or null for a name that matched no
   * issue on this job. The identifier, not the row id, because the number is
   * the thing anybody has written down.
   */
  issueNumber: number | null;
  /**
   * The observation it evidences, or null (issue #113). The row id and not an
   * identifier, because an observation has none: it is read through the walk
   * it was made on, which is the payload this arrives in.
   */
  observationId: string | null;
  createdAt: string;
}

export interface PhotoBody {
  filename: string;
  takenAt: string;
  contentType: string;
  /** The bytes, base64. The record keeps the key; the store keeps these. */
  bytes: string;
}

/** Two pixels of PNG, which is a real image and small enough to inline. */
export const A_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A valid create body, so a test about the filename does not have to restate
 * the bytes. The default name matches no issue, so binding is something a
 * test asks for rather than something it gets by accident.
 */
export function photoBody(patch: Partial<PhotoBody> = {}): PhotoBody {
  return {
    filename: 'IMG_0003.jpg',
    takenAt: '2026-07-23T13:20:00.000Z',
    contentType: 'image/png',
    bytes: A_PIXEL,
    ...patch,
  };
}

/** Fixtures are built through the API, never by writing to the database. */
export async function addPhoto(
  api: TestApi,
  siteVisitId: string,
  patch: Partial<PhotoBody> = {},
): Promise<PhotoResponse> {
  const path = `/v1/site-visits/${siteVisitId}/photos`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(photoBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as PhotoResponse;
}

/**
 * A transcription vendor that always says the same thing.
 *
 * The default for every test that is not about transcription: the seam the
 * plan names for "the OCR/extraction vendor and the transcription vendor,
 * behind their own thin ports".
 */
export function fakeTranscriber(
  transcript = 'Fire rated wall penetration left unsealed above the ceiling',
) {
  return { transcribe: () => Promise.resolve(transcript) };
}

/** A vendor that refuses, which is the same stored fact as one that errors. */
export function refusingTranscriber(reason: string) {
  return { transcribe: () => Promise.reject(new Error(reason)) };
}

/**
 * A vendor that does not answer until the test says so, so that *transcribing*
 * is a state a test can stand in and look at.
 *
 * `reached` resolves once the worker has actually called it, which is the only
 * way to know the job was picked up without sleeping.
 */
export function heldTranscriber(
  transcript = 'Held until the test releases it',
) {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    reached,
    release: () => release(),
    transcribe: () => {
      arrive();
      return held.then(() => transcript);
    },
  };
}

/** What the agent proposed on its turn, or null (issue #114). */
export interface ProposalResponse {
  observed: string;
  floor: string;
  qualifier: string;
  side: string | null;
  sector: string | null;
  /** The grammar, composed on every read as an observation's is (ADR-0030). */
  location: string;
  issueId: string | null;
}

/** The assumption record the agent proposed on its turn, or null (#121). */
export interface RecordProposalResponse {
  submissionId: string;
  /** Verbatim, and byte-for-byte what the helper printed. */
  assumptions: string;
  flags: string;
  codeEdition: string;
}

/** A turn as the API returns it. Never its audio, never its key. */
export interface TurnResponse {
  id: string;
  conversationId: string;
  speaker: 'ENGINEER' | 'AGENT';
  /** Where it sits in the conversation, from 1. */
  position: number;
  /** Which kind of capture the engineer made. Null on the agent's turn. */
  kind: 'VOICE' | 'TYPED' | null;
  /** What the client called it, so a resend after a signal drop lands once. */
  captureKey: string | null;
  recordedAt: string | null;
  contentType: string | null;
  byteSize: number | null;
  /** Stamped when the worker picked it up. Null while it is still queued. */
  transcribingSince: string | null;
  /** What was said, verbatim, and never rewritten by a correction. */
  transcript: string | null;
  transcribedAt: string | null;
  failedAt: string | null;
  failure: string | null;
  createdAt: string;
  /** The run this turn is, on the agent's turn and nowhere else. */
  agentRunId: string | null;
  /** Derived from the four stamps on every read, and stored nowhere. */
  state: 'queued' | 'transcribing' | 'transcribed' | 'failed';
  /** The draft the agent proposed, or null on every other turn. */
  proposal: ProposalResponse | null;
  /** The record the agent proposed, or null on every other turn (#121). */
  proposedAssumptionRecord: RecordProposalResponse | null;
  /** The record that proposal became, or null while it is still one (#121). */
  assumptionRecord: { id: string; submissionId: string } | null;
  /** The observation it became, or null while it is still a draft. */
  observation: ObservationResponse | null;
}

/** One proposal run held on a conversation. The state, never the stamps. */
export interface CaptureRunResponse {
  id: string;
  createdAt: string;
  failure: string | null;
  state: 'queued' | 'running' | 'finished' | 'failed';
}

/** A walk's conversation, with its turns in order (issue #114). */
export interface ConversationResponse {
  id: string;
  projectId: string;
  siteVisitId: string | null;
  createdAt: string;
  turns: TurnResponse[];
  /** The proposal runs asked for on it, oldest first. */
  runs: CaptureRunResponse[];
}

export interface TurnBody {
  kind: 'VOICE' | 'TYPED';
  captureKey: string;
  recordedAt: string;
  contentType?: string;
  /** The audio, base64. The record keeps the key; the store keeps these. */
  bytes?: string;
  /** What was typed, on a typed capture and never beside audio. */
  text?: string;
}

/**
 * A short run of bytes standing in for audio.
 *
 * Nothing in this product ever decodes it — the vendor is behind a port and
 * the read route hands the bytes straight back — so what matters is only that
 * it is a real, non-empty, byte-exact payload to compare against.
 */
export const A_SOUND = 'T2dnUwACAAAAAAAAAABzcGVha2luZw==';

/** A valid create body, so a test about one field need not restate the rest. */
export function turnBody(patch: Partial<TurnBody> = {}): TurnBody {
  const base: TurnBody = {
    kind: 'VOICE',
    captureKey: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
    recordedAt: '2026-07-23T13:20:00.000Z',
    contentType: 'audio/webm',
    bytes: A_SOUND,
  };
  // A typed capture carries no audio at all, and the boundary refuses a body
  // that mixes the two — so patching the kind swaps the branch rather than
  // adding to it, which is what lets a test say `{ kind: 'TYPED', text }`.
  if (patch.kind === 'TYPED') {
    const { contentType: _type, bytes: _bytes, ...typed } = base;
    return { ...typed, text: 'south stair, cracked tile', ...patch };
  }
  return { ...base, ...patch };
}

/** Fixtures are built through the API, never by writing to the database. */
export async function addTurn(
  api: TestApi,
  siteVisitId: string,
  patch: Partial<TurnBody> = {},
): Promise<TurnResponse> {
  const path = `/v1/site-visits/${siteVisitId}/turns`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(turnBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as TurnResponse;
}

/**
 * A conversation opened on a project (issue #121), through the route.
 *
 * A walk's is created with the walk and has no route; a project's is opened by
 * one, because a project has any number of them.
 */
export async function openConversation(
  api: TestApi,
  projectId: string,
): Promise<ConversationResponse> {
  const path = `/v1/projects/${projectId}/conversations`;
  const response = await api.fetch(path, { method: 'POST' });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as ConversationResponse;
}

/** A question typed into a project's conversation (issue #121). */
export async function askOnProject(
  api: TestApi,
  conversationId: string,
  patch: { captureKey?: string; text?: string } = {},
): Promise<TurnResponse> {
  const path = `/v1/conversations/${conversationId}/turns`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      captureKey: 'q1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
      text: 'what did we assume about the feeder raceway?',
      ...patch,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as TurnResponse;
}

/** One conversation read back by its own id. */
export async function conversationById(
  api: TestApi,
  conversationId: string,
): Promise<ConversationResponse> {
  const path = `/v1/conversations/${conversationId}`;
  const response = await api.fetch(path);
  if (response.status !== 200) {
    throw new Error(`fixture failed: GET ${path} returned ${response.status}`);
  }
  return (await response.json()) as ConversationResponse;
}

/** The walk's conversation, read on its own. */
export async function conversationOn(
  api: TestApi,
  siteVisitId: string,
): Promise<ConversationResponse> {
  const path = `/v1/site-visits/${siteVisitId}/conversation`;
  const response = await api.fetch(path);
  if (response.status !== 200) {
    throw new Error(`fixture failed: GET ${path} returned ${response.status}`);
  }
  return (await response.json()) as ConversationResponse;
}

/** A site visit report as the API returns it (issue #13). */
export interface SiteVisitReportResponse {
  id: string;
  siteVisitId: string;
  /**
   * The four stamps the state is read from. Queued is all four null; the
   * document's size arrives with `renderedAt`.
   */
  renderingSince: string | null;
  renderedAt: string | null;
  byteSize: number | null;
  failedAt: string | null;
  failure: string | null;
  createdAt: string;
  /** Derived on every read from the four stamps and stored nowhere. */
  state: 'queued' | 'rendering' | 'rendered' | 'failed';
}

/** Fixtures are built through the API, never by writing to the database. */
export async function generateReport(
  api: TestApi,
  siteVisitId: string,
): Promise<SiteVisitReportResponse> {
  const path = `/v1/site-visits/${siteVisitId}/reports`;
  const response = await api.fetch(path, { method: 'POST' });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as SiteVisitReportResponse;
}

/** One handoff, as the API returns it (issue #14). */
export interface BallInCourtResponse {
  id: string;
  registerEntryId: string;
  /** Who holds it. Free text, as every party in this product is. */
  party: string;
  /**
   * Whether that party is us. The fact issue #15's accrual reads, stored
   * rather than derived from the name.
   */
  inOurCourt: boolean;
  /** From when. The start of an interval the next handoff ends. */
  heldSince: string;
  createdAt: string;
  /**
   * The person it came to, where it came to us, and null where it went out
   * to another party (issue #112). Never the raw `user_id`.
   */
  user: UserResponse | null;
}

/** A register entry as the API returns it. */
export interface RegisterEntryResponse {
  id: string;
  registerId: string;
  /** Whose log it is in, and whose job — both off the register. */
  kind: 'SUBMITTAL' | 'RFI';
  projectId: string;
  /** What it is filed under. The engineer's, never allocated. */
  number: string;
  subject: string;
  fromParty: string;
  toParty: string;
  /** Both null on a submittal; the response lands after the question. */
  question: string | null;
  response: string | null;
  /** The issuance that answered it, if one has (story 81). */
  submissionId: string | null;
  /** The contractual turnaround in whole days, or none set (story 73). */
  turnaroundDays: number | null;
  /** The outcome of a review and the day it was reached; both or neither. */
  disposition: string | null;
  disposedAt: string | null;
  /** The round this one follows, and the one that followed it (story 77). */
  previousRoundId: string | null;
  nextRoundId: string | null;
  createdAt: string;
  /**
   * Whose move it is now: the last handoff, derived on every read and stored
   * nowhere.
   */
  ballInCourt: BallInCourtResponse | null;
  /**
   * Elapsed in-court time in milliseconds: the sum of the intervals the ball
   * was ours, with the open one running to now. Derived on every read.
   */
  inCourtMs: number;
  /** Sitting in our court, with a target, and over it (stories 43, 74). */
  pastClock: boolean;
  /** Every handoff, in the order the ball moved. This list is the history. */
  handoffs: BallInCourtResponse[];
  /** What is being chased for this entry, oldest first. */
  openItems: OpenItemResponse[];
}

/** A register as the API returns it. */
export interface RegisterResponse {
  id: string;
  projectId: string;
  kind: 'SUBMITTAL' | 'RFI';
  createdAt: string;
  entries: RegisterEntryResponse[];
}

export interface HandoffBody {
  party: string;
  inOurCourt: boolean;
  heldSince?: string;
  userId?: string;
}

export interface RegisterEntryBody {
  number: string;
  subject: string;
  fromParty: string;
  toParty: string;
  question?: string;
  turnaroundDays?: number;
  ballInCourt: HandoffBody;
}

/** An entry on the clock, carrying the job it is on (issue #15). */
export interface ClockRow extends RegisterEntryResponse {
  project: { id: string; projectNumber: string; name: string };
}

/**
 * A valid handoff, so a test about one field does not have to restate the
 * other two. The patch is untyped rather than `Partial<HandoffBody>` because
 * one test sends a court that is not a boolean, which is exactly the body the
 * schema exists to refuse.
 */
export function handoffBody(patch: Record<string, unknown> = {}): HandoffBody {
  const body: Record<string, unknown> = {
    party: 'Acme Mechanical',
    inOurCourt: false,
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body as unknown as HandoffBody;
}

/**
 * Whoever is signed in, on a handoff that brings the ball to us (issue #112).
 *
 * The fixture supplies the person the way it supplies the session: a handoff
 * in our court names one, and restating `api.user.id` at every call site would
 * say nothing about a test whose subject is something else. A test that *is*
 * about the rule posts its own body and sends none, or sends another account's.
 */
export function ours(api: TestApi, patch: Record<string, unknown> = {}) {
  return handoffBody({ party: 'Us', inOurCourt: true, userId: api.user.id, ...patch });
}

export function registerEntryBody(
  patch: Partial<RegisterEntryBody> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    number: 'SUB-001',
    subject: 'Rooftop unit shop drawings',
    fromParty: 'Acme Mechanical',
    toParty: 'Us',
    ballInCourt: handoffBody({ party: 'Us', inOurCourt: true }),
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/** The two logs a project is created with, submittals first. */
export async function listRegisters(
  api: TestApi,
  projectId: string,
): Promise<RegisterResponse[]> {
  const path = `/v1/projects/${projectId}/registers`;
  const response = await api.fetch(path);
  if (response.status !== 200) {
    throw new Error(`fixture failed: GET ${path} returned ${response.status}`);
  }
  return (await response.json()) as RegisterResponse[];
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createRegisterEntry(
  api: TestApi,
  registerId: string,
  patch: Partial<RegisterEntryBody> = {},
): Promise<RegisterEntryResponse> {
  const path = `/v1/registers/${registerId}/entries`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registerEntryBody({ ballInCourt: ours(api), ...patch })),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as RegisterEntryResponse;
}

/** A document version as the API returns it. Never its storage key. */
export interface DocumentVersionResponse {
  id: string;
  documentId: string;
  /** The designation printed on the sheet — "C", "Rev 2", "Addendum 1". */
  revision: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

/** A document as the API returns it, with every version it has ever had. */
export interface DocumentResponse {
  id: string;
  projectId: string;
  title: string;
  /**
   * Stored and linked but deliberately not parsed. Stamped when the document
   * is recorded and never edited, so an 86-sheet set is out of reach of
   * extraction from the moment it exists.
   */
  referencedFile: boolean;
  createdAt: string;
  versions: DocumentVersionResponse[];
}

/**
 * A version read through the structure it is linked to — a submission, a
 * register entry — carrying the document it is a version of.
 */
export interface LinkedDocumentVersion extends DocumentVersionResponse {
  document: {
    id: string;
    projectId: string;
    title: string;
    referencedFile: boolean;
    createdAt: string;
  };
}

export interface DocumentVersionBody {
  revision: string;
  filename: string;
  contentType: string;
  /** The bytes, base64. The row keeps the key; the store keeps these. */
  bytes: string;
}

export interface DocumentBody {
  title: string;
  referencedFile: boolean;
  /**
   * Named in the same call that records the document, so a document is never
   * a title with no bytes — ADR-0026's shape for what a set rests on and
   * ADR-0036's for an entry's first handoff.
   */
  version: DocumentVersionBody;
}

/**
 * What a test overrides, with the version's fields overridable one at a time
 * — a test about a blank revision should not have to restate the bytes.
 */
export type DocumentPatch = Partial<Omit<DocumentBody, 'version'>> & {
  version?: Partial<DocumentVersionBody>;
};

/**
 * Sixty-nine bytes of real PDF.
 *
 * Nothing in this product ever decodes it — no route reads a document's
 * contents, which is the whole of why this ticket is not gated on employer
 * consent — so what matters is only that it is a real, non-empty, byte-exact
 * payload to compare against.
 */
export const A_PAGE =
  'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK';

/**
 * A base64 body past the size at which the old quartet pattern recursed.
 *
 * Four and a half million characters, which is a file of about 3.4 MiB — an
 * ordinary photograph off a phone, a short recording, a small drawing.
 * `^(?:[A-Za-z0-9+/]{4})*(?:…)?$` passes at four million and throws
 * `RangeError: Maximum call stack size exceeded` here, and with no
 * `setErrorHandler` in this product that reached the caller as a 500 carrying
 * V8's own sentence (issue #98).
 *
 * A whole number of quartets, so it is *valid* base64 and reaches the pattern
 * rather than being turned away by the cheap length check in front of it —
 * which is the point: every other fixture here is a few hundred characters,
 * and that is why a rule that was correct and tested was never exercised at
 * the size it exists for. Append one character to get the 4n+1 refusal.
 */
export const PAST_THE_STACK = 'A'.repeat(4_500_000);

export function documentVersionBody(
  patch: Partial<DocumentVersionBody> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    revision: 'C',
    filename: 'T-1 Electrical.pdf',
    contentType: 'application/pdf',
    bytes: A_PAGE,
    ...patch,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/**
 * A valid create body, so a test about the title does not have to restate the
 * bytes. The default is a referenced file, which is what the ticket is about.
 */
export function documentBody(
  patch: DocumentPatch = {},
): Record<string, unknown> {
  const { version, ...rest } = patch;
  const body: Record<string, unknown> = {
    title: 'Electrical drawing set',
    referencedFile: true,
    version: documentVersionBody(version),
    ...rest,
  };

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function addDocument(
  api: TestApi,
  projectId: string,
  patch: DocumentPatch = {},
): Promise<DocumentResponse> {
  const path = `/v1/projects/${projectId}/documents`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(documentBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as DocumentResponse;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function addDocumentVersion(
  api: TestApi,
  documentId: string,
  patch: Partial<DocumentVersionBody> = {},
): Promise<DocumentResponse> {
  const path = `/v1/documents/${documentId}/versions`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(documentVersionBody(patch)),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as DocumentResponse;
}

// ── Ingest (issue #19) ───────────────────────────────────────────────────

/** One file of an arrival, as the API returns it. Never its storage key. */
export interface IngestedDocumentFileResponse {
  id: string;
  ingestedDocumentId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

/** An arrival as the API returns it (issue #19). */
export interface IngestedDocumentResponse {
  id: string;
  projectId: string;
  source: 'EMAIL' | 'MANUAL';
  arrivedAt: string;
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  body: string | null;
  note: string | null;
  files: IngestedDocumentFileResponse[];
}

export interface IngestedFileBody {
  filename: string;
  contentType: string;
  /** The bytes, base64. */
  bytes: string;
}

/** Sixty-nine bytes of real PDF, as the ingest tests use. */
const A_LETTER =
  'JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCg==';

/** A valid file body, so a test about one field does not restate the rest. */
export function ingestedFileBody(
  patch: Partial<IngestedFileBody> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filename: 'rfi-001.pdf',
    contentType: 'application/pdf',
    bytes: A_LETTER,
    ...patch,
  };
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      delete body[key];
    }
  }
  return body;
}

/**
 * Entering an arrival by hand (story 93's fallback), which is the path an
 * extraction test takes its source from. Fixtures are built through the API,
 * never by writing to the database.
 */
export async function addIngestedDocument(
  api: TestApi,
  projectId: string,
  patch: { note?: string; files?: Partial<IngestedFileBody>[] } = {},
): Promise<IngestedDocumentResponse> {
  const path = `/v1/projects/${projectId}/ingested-documents`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: (patch.files ?? [{}]).map((file) => ingestedFileBody(file)),
      ...(patch.note === undefined ? {} : { note: patch.note }),
    }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as IngestedDocumentResponse;
}

/**
 * Poll a read until it answers, with a deadline rather than a sleep — how a
 * test watches a worker-driven state move. Written inside memory.test.ts
 * while one file waited on runs, and moved here when extractions.test.ts
 * became the second — the trigger ADR-0033 names.
 */
export async function until<T>(
  read: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ── Project memory (issue #18) ───────────────────────────────────────────

/** A project's memory as the API returns it: the latest version, derived. */
export interface MemoryResponse {
  projectId: string;
  /** Null until the first version is written. */
  content: string | null;
  /** How many versions stand behind the current one, it included. */
  versions: number;
  /** The current content's length, against the budget beside it. */
  size: number;
  budget: number;
  /** When the current version was written, or null while there is none. */
  versionedAt: string | null;
}

/** One state of a project's memory, as the history returns it. */
export interface MemoryVersionResponse {
  id: string;
  projectId: string;
  content: string;
  proposalId: string | null;
  createdAt: string;
}

/** A run of the agent, with its state derived from the four stamps. */
export interface AgentRunResponse {
  id: string;
  projectId: string;
  runningSince: string | null;
  finishedAt: string | null;
  failedAt: string | null;
  failure: string | null;
  createdAt: string;
  state: 'queued' | 'running' | 'finished' | 'failed';
}

/** A proposed memory edit, with its resolution derived from the stamps. */
export interface MemoryProposalResponse {
  id: string;
  projectId: string;
  runId: string;
  /** What the memory said when the run began; null when there was none. */
  baseContent: string | null;
  proposed: string;
  createdAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  state: 'pending' | 'accepted' | 'rejected';
  /** Whether the memory has moved since `baseContent` was snapshotted. */
  stale: boolean;
}

/** One line of the append-only audit record. */
export interface AuditEntryResponse {
  id: string;
  projectId: string;
  /** Who, by name. Null on the lines nobody presented a session for. */
  actor: { id: string; name: string } | null;
  /** The run it was written during, never the session it held (issue #111). */
  run: { type: 'agent-run' | 'extraction'; id: string } | null;
  /** Which row. Null only on lines written before issue #111. */
  subject: { type: string; id: string } | null;
  action: string;
  detail: string;
  createdAt: string;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function writeMemory(
  api: TestApi,
  projectId: string,
  content: string,
): Promise<MemoryResponse> {
  const path = `/v1/projects/${projectId}/memory`;
  const response = await api.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as MemoryResponse;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function requestMemoryRun(
  api: TestApi,
  projectId: string,
): Promise<AgentRunResponse> {
  const path = `/v1/projects/${projectId}/memory/runs`;
  const response = await api.fetch(path, { method: 'POST' });
  if (response.status !== 201) {
    throw new Error(`fixture failed: POST ${path} returned ${response.status}`);
  }
  return (await response.json()) as AgentRunResponse;
}

/**
 * An agent that proposes one fixed line, through the real route.
 *
 * The default for every memory test that is not about the agent itself, and
 * the honest shape of the genuine adapter: the proposal is written by calling
 * the internal API — here `app.inject`, the same routes without the socket —
 * and never by touching the database. Self-describing, like the stub
 * transcriber's line, so a screen exercised against it says what it is.
 *
 * The extraction half proposes one fixed RFI the same way, through the real
 * proposal route. Its payload includes the title and revision the arrival
 * path proposes, so a test whose source is a stored document passes its own
 * proposal — that path refuses the pair.
 *
 * The capture half proposes one fixed draft, again through the real route: a
 * floor, a qualifier, an axis and words that say what they are. A test that
 * wants the agent's **question** instead passes `{ question: '…' }` as the
 * proposal, which is the same route's other branch.
 *
 * The project-chat half (issue #121) answers in words, which is what a chat
 * run does when no submission has been named — the branch that needs no
 * fixture to exist first. A test that wants a **proposed record** passes one as
 * `chatProposal`, naming a submission it made itself.
 */
export function fakeAgentRunService(
  app: {
    inject: (request: {
      method: string;
      url: string;
      payload: unknown;
      headers: Record<string, string>;
    }) => Promise<unknown>;
  },
  content = '[fake agent proposal — a stand-in for what the model would write]',
  extractionProposal: Record<string, unknown> = {
    kind: 'RFI',
    number: 'RFI-001',
    subject: 'Clarification of the baseplate detail',
    fromParty: 'Acme Mechanical',
    toParty: 'the engineer',
    question: 'which baseplate detail governs at Grid C4?',
    ballInCourt: {
      party: 'the engineer',
      inOurCourt: true,
      heldSince: '2026-09-01T09:00:00.000Z',
    },
    title: 'RFI-001 baseplate detail',
    revision: 'A',
  },
  captureProposal: Record<string, unknown> = {
    observed: '[fake agent draft] cracked tile at the south stair',
    floor: '3',
    qualifier: 'south stair',
    side: 'A',
  },
  chatProposal: Record<string, unknown> = {
    answer: '[fake agent answer — a stand-in for what the model would say]',
  },
): AgentRunService {
  return {
    proposeMemoryEdit: async ({ runId, sessionId }) => {
      await app.inject({
        method: 'POST',
        url: `/v1/memory-runs/${runId}/proposal`,
        payload: { content },
        // `inject` runs the whole lifecycle, the gate included, exactly as
        // the real adapter's HTTP call does — and it presents the run's own
        // session, as the real one does (ADR-0055).
        headers: { [SESSION_HEADER]: sessionId },
      });
    },
    extractRegisterEntry: async ({ extractionId, sessionId }) => {
      await app.inject({
        method: 'POST',
        url: `/v1/extractions/${extractionId}/proposal`,
        payload: extractionProposal,
        headers: { [SESSION_HEADER]: sessionId },
      });
    },
    proposeCapture: async ({ runId, sessionId }) => {
      await app.inject({
        method: 'POST',
        url: `/v1/capture-runs/${runId}/proposal`,
        payload: captureProposal,
        headers: { [SESSION_HEADER]: sessionId },
      });
    },
    proposeAssumptionRecord: async ({ runId, sessionId }) => {
      await app.inject({
        method: 'POST',
        url: `/v1/assumption-record-runs/${runId}/proposal`,
        payload: chatProposal,
        headers: { [SESSION_HEADER]: sessionId },
      });
    },
  };
}

/** An agent that fails, which is the same stored fact as one that errors. */
export function refusingAgentRunService(reason: string): AgentRunService {
  return {
    proposeMemoryEdit: () => Promise.reject(new Error(reason)),
    extractRegisterEntry: () => Promise.reject(new Error(reason)),
    proposeCapture: () => Promise.reject(new Error(reason)),
    proposeAssumptionRecord: () => Promise.reject(new Error(reason)),
  };
}

/**
 * An agent that does not answer until the test says so, so that *running* is
 * a state a test can stand in and look at — `heldTranscriber`'s shape.
 *
 * `reached` resolves once the worker has actually called it, which is the only
 * way to know the job was picked up without sleeping.
 */
export function heldAgentRunService() {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service: AgentRunService = {
    proposeMemoryEdit: async () => {
      arrive();
      await held;
    },
    extractRegisterEntry: async () => {
      arrive();
      await held;
    },
    proposeCapture: async () => {
      arrive();
      await held;
    },
    proposeAssumptionRecord: async () => {
      arrive();
      await held;
    },
  };
  return { service, reached, release };
}

/**
 * An OCR provider that answers one fixed page, for the extraction tests
 * (issue #20) — `fakeTranscriber`'s shape for the other vendor the pipeline
 * leaves the process for.
 */
export function fakeOcrProvider(
  text = '[fake OCR page — a stand-in for what the vendor would read]',
): OcrProvider {
  return { read: () => Promise.resolve(text) };
}

/** An OCR provider that fails, which is the same stored fact as one that errors. */
export function refusingOcrProvider(reason: string): OcrProvider {
  return { read: () => Promise.reject(new Error(reason)) };
}

/**
 * An OCR provider that answers as `fakeOcrProvider` does and counts the asks
 * (issue #21).
 *
 * "Never sends document content to a cloud vendor" is a statement about a call
 * that did not happen, and no row records one of those. This is the only way
 * to assert it from the outside: the port is the boundary the document's bytes
 * would cross, so counting crossings is counting exactly the thing.
 */
export function recordingOcrProvider(): OcrProvider & { calls: number } {
  const provider = {
    calls: 0,
    read: (_bytes: Buffer, _contentType: string, _filename: string) => {
      provider.calls += 1;
      return Promise.resolve('[recording OCR page]');
    },
  };
  return provider;
}

/**
 * The `data:` payloads of a server-sent event stream, one call at a time.
 *
 * Written inside voice.test.ts while one test file read a stream, and moved
 * here when memory.test.ts became the second — the trigger ADR-0033 names.
 */
export function sseFrames<T>(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next(): Promise<T> {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          // Heartbeats are comments and carry no data.
          if (frame.startsWith('data: ')) {
            return JSON.parse(frame.slice(6)) as T;
          }
          continue;
        }
        const { done, value } = await reader.read();
        if (done) {
          throw new Error('the progress stream ended');
        }
        buffered += decoder.decode(value, { stream: true });
      }
    },
    /** Lets the socket go, the way the browser closing the tab would. */
    close() {
      void reader.cancel();
    },
  };
}
