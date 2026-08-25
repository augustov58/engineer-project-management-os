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
