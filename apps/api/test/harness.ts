import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { inject } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import { buildServer } from '../src/server.js';
import type { TimeSource } from '../src/time-source.js';

export interface TestApi {
  /** Origin of a real listening HTTP server, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /** `fetch` against this API. Tests assert on the response, nothing else. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * The tables the migrations actually produced.
   *
   * The one sanctioned way past the HTTP boundary, because "no `users` table
   * exists" (ADR-0012) is a schema invariant no route can ever expose. It
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
 * state and never need to clean up after each other. Nothing here is mocked
 * or substituted: the only injectable is the time source, which is the one
 * seam the plan names.
 */
export async function startTestApi(
  options: { timeSource?: TimeSource } = {},
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

  const runtime = createRuntime({
    databaseUrl: databaseUrl.toString(),
    redisUrl: inject('redisUrl'),
    queueName: `test-${database}`,
  });

  const app = buildServer({
    prisma: runtime.prisma,
    queue: runtime.queue,
    timeSource: options.timeSource,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the test API to be listening on a TCP port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    fetch: (path, init) => fetch(`${baseUrl}${path}`, init),
    tableNames: async () => {
      const rows = await runtime.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `;
      return rows.map((row) => row.table_name);
    },
    close: async () => {
      await app.close();
      await runtime.close();

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
  archivedAt: string | null;
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createProject(
  api: TestApi,
  projectNumber: string,
  name: string,
): Promise<ProjectResponse> {
  const response = await api.fetch('/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectNumber, name }),
  });
  if (response.status !== 201) {
    throw new Error(
      `fixture failed: POST /v1/projects returned ${response.status}`,
    );
  }
  return (await response.json()) as ProjectResponse;
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
  owner: string | null;
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
  owner?: string;
}

/**
 * A valid create body, so a test that is about one field does not have to
 * restate the other three that are required.
 *
 * Patching a field to `undefined` leaves it off the wire entirely rather than
 * sending a null, which is how a test says "this field was not supplied".
 */
export function openItemBody(
  patch: Partial<OpenItemBody> = {},
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
  assumptionLines: AssumptionLine[];
  flagLines: FlagLine[];
}

export interface AssumptionRecordBody {
  assumptions: string;
  flags: string;
  codeEdition: string;
  calculatedAt?: string;
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
