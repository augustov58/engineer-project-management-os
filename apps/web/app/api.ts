const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3001';

export interface Project {
  id: string;
  projectNumber: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  /** The phase a new submission defaults to. Null until one is chosen. */
  currentPhaseId: string | null;
}

/** Every call goes through the versioned prefix the API serves. */
export function apiPath(path: string): string {
  return `${apiUrl}/v1${path}`;
}

/** `archived: true` for the finished jobs, which is how they stay reachable. */
export async function listProjects(archived = false): Promise<Project[]> {
  const path = `/projects?archived=${archived}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<Project[]>;
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getProject(id: string): Promise<Project | undefined> {
  const path = `/projects/${id}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<Project>;
}

export interface OpenItem {
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

/** The pending items view carries the job each item is on. */
export interface PendingItem extends OpenItem {
  project: { id: string; projectNumber: string; name: string } | null;
}

/** `resolved: true` for the answered ones, which stay on the project. */
export async function listOpenItems(
  projectId: string,
  resolved = false,
): Promise<OpenItem[]> {
  const path = `/projects/${projectId}/open-items?resolved=${resolved}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<OpenItem[]>;
}

/**
 * Every unresolved open item across every project. An empty `waitingOn` is no
 * filter at all; the reserved word `nobody` is how you ask for the items no
 * one owes a move on.
 */
export async function listPendingItems(options: {
  waitingOn?: string;
  sort?: 'oldest' | 'newest';
}): Promise<PendingItem[]> {
  const query = new URLSearchParams({ sort: options.sort ?? 'oldest' });
  if (options.waitingOn !== undefined && options.waitingOn !== '') {
    query.set('waitingOn', options.waitingOn);
  }

  const path = `/open-items?${query.toString()}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<PendingItem[]>;
}

export interface Phase {
  id: string;
  projectId: string;
  name: string;
  position: number;
}

export interface Submission {
  id: string;
  projectId: string;
  phaseId: string;
  issuedAt: string;
  recipient: string;
  recipientRole: string;
  revision: string;
  sheetList: string;
  createdAt: string;
}

/** One submission, with the things it hangs off resolved. */
export interface SubmissionDetail extends Submission {
  phase: Phase;
  project: { id: string; projectNumber: string; name: string };
  /** What the issuance rests on — resolved ones included, deliberately. */
  openItems: OpenItem[];
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** A project's phases, in the order the engineer put them in. */
export function listPhases(projectId: string): Promise<Phase[]> {
  return read<Phase[]>(`/projects/${projectId}/phases`);
}

/** Oldest first: this screen is a chronicle of what went out. */
export function listSubmissions(projectId: string): Promise<Submission[]> {
  return read<Submission[]>(`/projects/${projectId}/submissions`);
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getSubmission(
  id: string,
): Promise<SubmissionDetail | undefined> {
  const path = `/submissions/${id}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<SubmissionDetail>;
}
