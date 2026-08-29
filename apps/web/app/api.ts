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
  /**
   * That the set went out on unconfirmed inputs. Stamped at issuance and never
   * recomputed, so resolving everything afterwards does not unsay it.
   */
  issuedProvisional: boolean;
  /**
   * That something it rests on is unresolved right now. Derived on every read
   * and stored nowhere — a different fact from the one above, and the one
   * exposure counts.
   */
  currentlyProvisional: boolean;
  /** The issuance this one replaced, or null if it replaced nothing. */
  supersedesId: string | null;
  /**
   * The issuance that replaced this one. Derived from a row pointing back at
   * it, never stored: marking the prior record would be the edit that reissue
   * exists to avoid (ADR-0015).
   */
  supersededById: string | null;
}

/** One issuance as its own supersede chain lists it. */
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

/** An open item, plus where it stood when the set it backs went out. */
export interface RestsOn extends OpenItem {
  /** Null is an item attached after the issuance, so no part of it. */
  unresolvedAtIssuance: boolean | null;
}

/** One submission, with the things it hangs off resolved. */
export interface SubmissionDetail extends Submission {
  phase: Phase;
  project: { id: string; projectNumber: string; name: string };
  /** What the issuance rests on — resolved ones included, deliberately. */
  openItems: RestsOn[];
  /**
   * The whole lineage, oldest issuance first. The same list whichever link it
   * is read from, which is how "what is the current issuance of this?" is
   * answered without reading email.
   */
  chain: ChainEntry[];
}

/** A currently provisional submission, as the exposure view lists it. */
export interface ExposureRow extends Submission {
  phase: Phase;
  project: { id: string; projectNumber: string; name: string };
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

/**
 * Exposure: the issued submissions currently carrying unresolved open items,
 * across every live project or within one (ADR-0016).
 *
 * The count is `.length`. There is no separate count call, so the number on a
 * screen and the rows it links to cannot disagree.
 */
export function listExposure(projectId?: string): Promise<ExposureRow[]> {
  return read<ExposureRow[]>(
    projectId === undefined ? '/exposure' : `/exposure?projectId=${projectId}`,
  );
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

/**
 * One line of a captured block, addressed by its number. Split from the block
 * on every read and stored nowhere, so a line and the block it came from
 * cannot disagree.
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
  openItem: OpenItem | null;
}

/**
 * The durable artifact of engineering reasoning: what a helper skill produced,
 * verbatim, bound to the submission it justified. The arithmetic is
 * reproducible without it; the reasoning is not.
 */
export interface AssumptionRecord {
  id: string;
  submissionId: string;
  assumptions: string;
  flags: string;
  codeEdition: string;
  calculatedAt: string;
  createdAt: string;
  assumptionLines: AssumptionLine[];
  flagLines: FlagLine[];
}

/** What was assumed when this went out, oldest calculation first. */
export function listAssumptionRecords(
  submissionId: string,
): Promise<AssumptionRecord[]> {
  return read<AssumptionRecord[]>(
    `/submissions/${submissionId}/assumption-records`,
  );
}

/**
 * One dated observation event against a building: a walk, with a start, an
 * end, and a per-floor schedule of when each floor was started and completed.
 *
 * It produces observations; it does not own their content.
 */
export interface SiteVisit {
  id: string;
  projectId: string;
  startedAt: string;
  /** Null while the walk is still under way. */
  endedAt: string | null;
  createdAt: string;
  /**
   * The day the walk started. Derived on every read and stored nowhere, so a
   * visit cannot be dated one day and started on another.
   */
  visitedOn: string;
}

/**
 * One floor's window in time. What a photograph's timestamp is binned against
 * (issue #11), which is the whole of its job — a window, not a location.
 */
export interface SiteVisitFloor {
  id: string;
  siteVisitId: string;
  floor: string;
  startedAt: string;
  /** Null while the floor is still being walked. */
  completedAt: string | null;
}

/**
 * Something recorded at a specific location and time.
 *
 * Most observations are not findings — the "Notable Observations (Non-Issues)"
 * table is the majority case — so there is no status here and nothing that
 * makes one a finding.
 */
export interface Observation {
  id: string;
  siteVisitId: string;
  /** What was observed. Not a *note*: this is the thing itself. */
  observed: string;
  observedAt: string;
  /** The location's components. Exactly one axis is set. */
  floor: string;
  qualifier: string;
  side: string | null;
  sector: string | null;
  createdAt: string;
  /**
   * `Floor N — <qualifier>, <Side|Sector>`, composed from the components on
   * every read and stored nowhere, so the parts and the string cannot
   * disagree.
   */
  location: string;
}

/**
 * A photograph taken on a walk, with the two bindings it arrived with.
 *
 * Its bytes are never in this interface. They are read through
 * `/photos/<id>/bytes`, which the Next server proxies, because a browser
 * pointed straight at the API would work on this machine and fail on the
 * second device.
 */
export interface Photo {
  id: string;
  siteVisitId: string;
  /** The name it arrived with, kept verbatim. It is the mechanism. */
  filename: string;
  takenAt: string;
  contentType: string;
  byteSize: number;
  /**
   * The floor its timestamp binned it to, or null when no single window
   * contained it — outside every one, or inside two at once. Stamped when the
   * photograph was added, and correctable.
   */
  floor: string | null;
  /**
   * The identifier of the finding its filename named, or null for a name that
   * named none. The number rather than the row id, because the identifier is
   * what the filename carried in.
   */
  issueNumber: number | null;
  createdAt: string;
}

/**
 * A recording made on a walk, and the draft observation it becomes (issue #12).
 *
 * The audio is not here and neither is the key it is under: the bytes come
 * back through `/voice-captures/:id/audio`, proxied by this app so the browser
 * never calls the API directly.
 */
export interface VoiceCapture {
  id: string;
  siteVisitId: string;
  captureKey: string;
  recordedAt: string;
  contentType: string;
  byteSize: number;
  transcribingSince: string | null;
  /** What the vendor heard, verbatim. A correction never rewrites it. */
  transcript: string | null;
  transcribedAt: string | null;
  failedAt: string | null;
  failure: string | null;
  createdAt: string;
  /** Derived from the four stamps on every read, and stored nowhere. */
  state: 'queued' | 'transcribing' | 'transcribed' | 'failed';
  /** The observation it became, or null while it is still a draft. */
  observation: Observation | null;
}

/**
 * Still with the vendor: queued, or being transcribed. Nothing for the
 * engineer to do yet.
 *
 * Here rather than beside any one of its readers, because the four-state union
 * is read on three screens and a fifth state would otherwise be an edit in
 * each of them. Not in a `'use client'` module: the site visit page is a
 * server component, and Next turns every export of a client module into a
 * client reference it cannot call.
 */
export function isWorking(capture: VoiceCapture): boolean {
  return capture.state === 'queued' || capture.state === 'transcribing';
}

/**
 * The engineer's move: a transcript to correct, or a failure to type from.
 * Both are drafts, and a failed one is still committable — that is what makes
 * a dead vendor unable to stop the walk being written up.
 */
export function awaitsReview(capture: VoiceCapture): boolean {
  return capture.observation === null && !isWorking(capture);
}

/** One visit, with the job it was against and what it produced. */
export interface SiteVisitDetail extends SiteVisit {
  project: { id: string; projectNumber: string; name: string };
  /** In the order the floors were walked. */
  floors: SiteVisitFloor[];
  /** In the order they were made. */
  observations: Observation[];
  /** In the order they were taken, which is the order the walk happened in. */
  photos: Photo[];
  /** What was spoken on this walk, in the order it was said. */
  voiceCaptures: VoiceCapture[];
}

/** Oldest first: this list is a chronicle of the walks on a job. */
export function listSiteVisits(projectId: string): Promise<SiteVisit[]> {
  return read<SiteVisit[]>(`/projects/${projectId}/site-visits`);
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getSiteVisit(
  id: string,
): Promise<SiteVisitDetail | undefined> {
  const path = `/site-visits/${id}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<SiteVisitDetail>;
}

/** One sighting of a finding: the observation, and the walk it was made on. */
export interface IssueObservation extends Observation {
  siteVisit: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    visitedOn: string;
  };
}

/**
 * A project-scoped **finding** with a stable identifier that survives the
 * report it first appeared in, so a later visit can re-observe, reopen or
 * close it.
 *
 * It owns no content of its own. What was seen, when and where belongs to the
 * observations, and an issue seen on three walks has three of them.
 */
export interface Issue {
  id: string;
  projectId: string;
  /** The identifier. Allocated once, never reused and never renumbered. */
  number: number;
  /** One of exactly five, in the words the glossary writes them. */
  category: string;
  /** Both null while the issue is open; both set once it is closed. */
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
  /** Every sighting, oldest first. This list is the history. */
  observations: IssueObservation[];
  /** What is being chased for this finding, oldest first. */
  openItems: OpenItem[];
  /** The photo evidence for this finding, across every walk it was seen on. */
  photos: Photo[];
}

/** By identifier: the register of what has been found on a job. */
export function listIssues(projectId: string): Promise<Issue[]> {
  return read<Issue[]>(`/projects/${projectId}/issues`);
}

/**
 * Resolving the stable identifier, which is what having one is for: a
 * reference printed in an issued report is looked up here.
 *
 * Undefined rather than throwing, so the page can render a 404.
 */
export async function getIssue(
  projectId: string,
  number: number,
): Promise<Issue | undefined> {
  const path = `/projects/${projectId}/issues/${number}`;
  const response = await fetch(apiPath(path), { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<Issue>;
}

/**
 * The findings seen on this walk that still have no photograph from it, read
 * before the report is written so it never ships with placeholders.
 *
 * A list, whose length is the count — so the number on the screen and the
 * findings it names cannot disagree.
 */
export function listIssuesWithoutPhotos(siteVisitId: string): Promise<Issue[]> {
  return read<Issue[]>(`/site-visits/${siteVisitId}/issues-without-photos`);
}
