import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  SIGN_IN_PATH,
  SIGN_IN_SOURCE_HEADER,
  SOURCE_HEADER,
} from './session';

const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3001';

/**
 * A job as another record names it: enough to label a row, and the zone its
 * times are read in (ADR-0054).
 *
 * The zone is on the stub and not only on the whole project, because the
 * screens that need it most are the ones that never fetch a project — a walk
 * is read with this, and the pending items, exposure, clock and issues views
 * each render rows from several jobs at once. A list across every project is
 * a list across every frame.
 */
export interface ProjectStub {
  id: string;
  projectNumber: string;
  name: string;
  timezone: string;
}

export interface Project {
  id: string;
  projectNumber: string;
  name: string;
  createdAt: string;
  /**
   * The zone of the building this job is at, as an IANA name (ADR-0054).
   *
   * Required with no default: every typed day and clock time on this job is
   * composed in it and every one is read back in it. Nothing else in this
   * product stores a zone — every other `DateTime` is a real instant.
   */
  timezone: string;
  archivedAt: string | null;
  /** The phase a new submission defaults to. Null until one is chosen. */
  currentPhaseId: string | null;
  /**
   * Where mail is forwarded to have it land on this job (issue #19).
   *
   * Composed by the API from a secret token it never sends on its own, and
   * null where the deployment has no ingest domain configured — which is the
   * honest answer rather than a plausible address that receives nothing.
   */
  ingestAddress: string | null;
  /**
   * Where this job's client-originated documents are read (issue #21).
   *
   * `CLOUD` on a project nobody has switched: ADR-0013 rejected local-first on
   * operational grounds and ADR-0044 settles the vault's contradiction that
   * way, so the default carries no sign-off and the route is the only gate.
   */
  processingLocation: 'LOCAL' | 'CLOUD';
  /** What the firm signed, and when they signed it. Both null or both set. */
  cloudSignoffReference: string | null;
  cloudSignoffAt: string | null;
}

/**
 * The path a call is made to, through the versioned prefix the API serves.
 *
 * A **path and not a URL**, which is deliberate since issue #22: `apiFetch`
 * below is the only thing that reaches the API, because it is the only place
 * the edge secret is attached, and a helper that composed a *usable* URL
 * would be a second door with nothing on it. It is exported for the messages
 * the readers below throw, where the origin was noise anyway.
 */
export function apiPath(path: string): string {
  return `/v1${path}`;
}

/**
 * What a caller wants done when the API says the session is not one.
 *
 * `sign-in` is right for every screen: the engineer's session was revoked or
 * has expired while they were reading, and the honest next thing is the
 * sign-in screen rather than a stack trace. `answer` is for the three readers
 * that must be able to hear *nobody* — the sign-in call itself, which is made
 * with no session on purpose; the header's read of who is signed in, which
 * renders on the sign-in screen too and would otherwise redirect to the page
 * it is already on, forever; and `/healthz`, the platform's check, which has
 * no session and never will, and reads the gate's 401 as proof the API
 * process answered (issue #106).
 */
export type Refusal = 'sign-in' | 'answer';

export interface ApiInit extends RequestInit {
  refusal?: Refusal;
}

/**
 * Every call this server makes to the API, carrying the session (ADR-0055).
 *
 * One function rather than the credential spelled at each call site: it was on
 * twenty-five of them when it was a secret, and when one was missed the whole
 * processing-location screen answered 401 with nothing in the suite to catch
 * it. A call that does not come through here does not reach the API at all,
 * and `apps/web/test/session.test.ts` asserts that by reading the source.
 *
 * The cookie is read here rather than passed in, so that no screen has to
 * remember to thread a credential down to a reader.
 */
export async function apiFetch(
  path: string,
  init: ApiInit = {},
): Promise<Response> {
  const { refusal = 'sign-in', ...request } = init;
  // Imported here rather than at the top of the file, and that is forced
  // rather than chosen: this module is read by client components too — they
  // take the closed vocabularies a record is displayed in from it — and a
  // top-level `next/headers` puts a server-only module into the browser's
  // graph, which Turbopack refuses to build. The call itself is server-only
  // either way: `cookies()` throws outside a request, so a client component
  // that reached for this door fails loudly rather than calling the API
  // without a session.
  const { cookies } = await import('next/headers');
  const session = (await cookies()).get(SESSION_COOKIE)?.value;

  const headers = new Headers(request.headers);
  if (session !== undefined) {
    // Merged rather than replacing, so a JSON write keeps its content type,
    // and set last so nothing can clear it by passing a header of this name.
    headers.set(SESSION_HEADER, session);
  }

  const response = await fetch(`${apiUrl}${apiPath(path)}`, {
    ...request,
    headers,
  });

  // Only when a session was actually presented: a 401 with none is the
  // sign-in route answering a wrong password, and redirecting there would
  // swallow the sentence the form is about to show.
  if (response.status === 401 && session !== undefined && refusal === 'sign-in') {
    redirect(SIGN_IN_PATH);
  }

  return response;
}

/** `archived: true` for the finished jobs, which is how they stay reachable. */
export async function listProjects(archived = false): Promise<Project[]> {
  const path = `/projects?archived=${archived}`;
  const response = await apiFetch(path, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<Project[]>;
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getProject(id: string): Promise<Project | undefined> {
  const path = `/projects/${id}`;
  const response = await apiFetch(path, { cache: 'no-store' });
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
  /**
   * The person it sits with, and what *mine* means on the pending items view
   * (issue #112, ADR-0055 part 5). Free text until then; never the raw id.
   */
  owner: User;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** The pending items view carries the job each item is on. */
export interface PendingItem extends OpenItem {
  project: ProjectStub | null;
}

/** `resolved: true` for the answered ones, which stay on the project. */
export async function listOpenItems(
  projectId: string,
  resolved = false,
): Promise<OpenItem[]> {
  const path = `/projects/${projectId}/open-items?resolved=${resolved}`;
  const response = await apiFetch(path, { cache: 'no-store' });
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
  mine?: boolean;
}): Promise<PendingItem[]> {
  const query = new URLSearchParams({ sort: options.sort ?? 'oldest' });
  if (options.waitingOn !== undefined && options.waitingOn !== '') {
    query.set('waitingOn', options.waitingOn);
  }
  if (options.mine === true) {
    query.set('mine', 'true');
  }

  const path = `/open-items?${query.toString()}`;
  const response = await apiFetch(path, { cache: 'no-store' });
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
  project: ProjectStub;
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
  project: ProjectStub;
}

async function read<T>(path: string): Promise<T> {
  const response = await apiFetch(path, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * The path one of the two daily lists is read at (issue #112).
 *
 * `mine` is the screens' default and the routes' — both of them — is *ours*:
 * what each route means is every job's, and which rows an engineer is shown
 * first is the screen's decision, which is ADR-0038's rule about the morning
 * screen applied to its filter rather than to a payload.
 */
function daily(path: string, projectId?: string, mine = false): string {
  const query = new URLSearchParams();
  if (projectId !== undefined) {
    query.set('projectId', projectId);
  }
  if (mine) {
    query.set('mine', 'true');
  }
  return query.size === 0 ? path : `${path}?${query.toString()}`;
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
export function listExposure(
  projectId?: string,
  mine = false,
): Promise<ExposureRow[]> {
  return read<ExposureRow[]>(daily('/exposure', projectId, mine));
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getSubmission(
  id: string,
): Promise<SubmissionDetail | undefined> {
  const path = `/submissions/${id}`;
  const response = await apiFetch(path, { cache: 'no-store' });
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
  /**
   * The agent's turn this was confirmed from, or null on one pasted in
   * (issue #121). The provenance ADR-0058 asks an assumption record to keep.
   */
  turnId: string | null;
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
  /**
   * Who walked the building, and whose name the report prints (issue #112).
   * Not who typed the row — that is an audit fact.
   */
  conductedBy: User;
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
  /**
   * The observation it evidences, or null (issue #113, ADR-0056). The row id
   * and not an identifier, unlike the finding above: an observation has none,
   * and it is read through the walk it was made on — which is the payload this
   * arrives in, so the screen has both sides already.
   *
   * At most one of this and `issueNumber` is set. Both null is **unfiled**: a
   * photograph on a floor and nothing else, which prints nowhere.
   */
  observationId: string | null;
  createdAt: string;
}

/**
 * One turn of a walk's conversation: what the engineer captured, or what the
 * agent proposed back (issue #12, widened by issue #114).
 *
 * The audio is not here and neither is the key it is under: the bytes come
 * back through `/turns/:id/audio`, proxied by this app so the browser never
 * calls the API directly.
 */
export interface Proposal {
  observed: string;
  floor: string;
  qualifier: string;
  side: string | null;
  sector: string | null;
  /** The grammar, composed by the API — never spelled a second time here. */
  location: string;
  /** The finding the agent read this as another sighting of, if it read one. */
  issueId: string | null;
}

/**
 * The assumption record the agent proposed on its turn (issue #121).
 *
 * The two blocks exactly as a helper printed them, the code edition, and the
 * submission it would be bound to. Beside `proposal` and not a union with it:
 * a CHECK says a turn proposes at most one of them, and a discriminant here
 * would be a second place that fact lived.
 */
export interface RecordProposal {
  submissionId: string;
  assumptions: string;
  flags: string;
  codeEdition: string;
}

export interface Turn {
  id: string;
  conversationId: string;
  /** Whose turn it is. */
  speaker: 'ENGINEER' | 'AGENT';
  /** Where it sits in the conversation, from 1. */
  position: number;
  /** Which kind of capture the engineer made. Null on the agent's turn. */
  kind: 'VOICE' | 'TYPED' | null;
  captureKey: string | null;
  recordedAt: string | null;
  contentType: string | null;
  byteSize: number | null;
  transcribingSince: string | null;
  /** What was said, verbatim. A correction never rewrites it. */
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
  proposal: Proposal | null;
  /** The record the agent proposed, or null on every other turn (#121). */
  proposedAssumptionRecord: RecordProposal | null;
  /**
   * The assumption record that proposal became, or null while it is still a
   * proposal (#121). `observation` below is the same fact on the other side of
   * the conversation: *confirmed* is there being one, and the panel withholds
   * the commit on the strength of it.
   */
  assumptionRecord: { id: string; submissionId: string } | null;
  /** The observation it became, or null while it is still a draft. */
  observation: Observation | null;
}

/**
 * One proposal run held on a conversation (issue #114).
 *
 * The state and not the stamps: a screen has nothing to do with when a run
 * started, only with whether it is still going — and `failure` is the sentence
 * it shows when it is not. What the run *proposed* is not here at all: that is
 * on its turn, on the conversation, and the run carries no transcript
 * (ADR-0040, kept by ADR-0058).
 */
export interface CaptureRun {
  id: string;
  createdAt: string;
  failure: string | null;
  state: 'queued' | 'running' | 'finished' | 'failed';
}

/** A conversation, with its turns in order (issue #114, ADR-0058). */
export interface Conversation {
  id: string;
  projectId: string;
  siteVisitId: string | null;
  createdAt: string;
  turns: Turn[];
  /** The proposal runs asked for on it, oldest first. */
  runs: CaptureRun[];
}

/**
 * The conversations open on a job, newest first (issue #121).
 *
 * A walk's is read through the walk and is not among these: a project's
 * conversation is about the job, and a field engineer's captures belong on the
 * screen for the walk they were made on.
 */
export function listProjectConversations(
  projectId: string,
): Promise<Conversation[]> {
  return read<Conversation[]>(`/projects/${projectId}/conversations`);
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
export function isWorking(turn: Turn): boolean {
  return turn.state === 'queued' || turn.state === 'transcribing';
}

/**
 * The engineer's move: a capture to correct, or a failure to type from. Both
 * are drafts, and a failed one is still committable — that is what makes a
 * dead vendor unable to stop the walk being written up.
 *
 * Never the agent's turn: a proposal is read beside the capture it answers and
 * is not itself a draft anybody confirms (issue #114).
 */
export function awaitsReview(turn: Turn): boolean {
  return (
    turn.speaker === 'ENGINEER' && turn.observation === null && !isWorking(turn)
  );
}

/**
 * A rendering of a walk into the document it is written up as (issue #13).
 *
 * The PDF is not here and neither is the key it is under: the bytes come back
 * through `/site-visit-reports/:id/pdf`, proxied by this app so the browser
 * never calls the API directly.
 */
export interface SiteVisitReport {
  id: string;
  siteVisitId: string;
  renderingSince: string | null;
  renderedAt: string | null;
  /** The size of the document, once there is one. */
  byteSize: number | null;
  failedAt: string | null;
  failure: string | null;
  createdAt: string;
  /** Derived from the four stamps on every read, and stored nowhere. */
  state: 'queued' | 'rendering' | 'rendered' | 'failed';
}

/** Still rendering: queued, or in the browser. Nothing to do but wait. */
export function isRendering(report: SiteVisitReport): boolean {
  return report.state === 'queued' || report.state === 'rendering';
}

/** One visit, with the job it was against and what it produced. */
export interface SiteVisitDetail extends SiteVisit {
  project: ProjectStub;
  /** In the order the floors were walked. */
  floors: SiteVisitFloor[];
  /** In the order they were made. */
  observations: Observation[];
  /** In the order they were taken, which is the order the walk happened in. */
  photos: Photo[];
  /** The walk's conversation, with its turns in order (issue #114). */
  conversation: Conversation;
  /** The write-ups asked for of this walk, oldest first. */
  reports: SiteVisitReport[];
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
  const response = await apiFetch(path, { cache: 'no-store' });
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

/** The across-every-project view carries the job each finding is on. */
export interface OpenIssue extends Issue {
  project: ProjectStub;
}

/**
 * Every finding still open, across every project (issue #64).
 *
 * The second across-every-project list after the pending items view, which is
 * its precedent: only what is still open, oldest first because the age is the
 * reason to look, and the job attached to every row. A **list and never a
 * number** — nothing renders its length on the morning screen, where a third
 * figure beside exposure and the clock is what ADR-0016 keeps out.
 */
export function listOpenIssues(options: {
  category?: string;
  sort?: 'oldest' | 'newest';
}): Promise<OpenIssue[]> {
  const query = new URLSearchParams({ sort: options.sort ?? 'oldest' });
  if (options.category !== undefined && options.category !== '') {
    query.set('category', options.category);
  }
  return read<OpenIssue[]>(`/issues?${query.toString()}`);
}

/**
 * The closed set of exactly five, in the words the glossary writes them.
 *
 * A second copy of the API's list, the way every interface here is a second
 * copy of the harness's — the two apps share no package, and they cannot
 * drift silently, because the API refuses a category it does not know and a
 * sixth typed here comes straight back as a refusal.
 *
 * Here rather than in `issue-form.tsx`, which held it until the filter on
 * `/issues` became a second reader (issue #64): that reason licenses one copy
 * on this side of the wire and not two, and this is where `REGISTER_NAMES`
 * already keeps the same kind of fact.
 */
export const ISSUE_CATEGORIES = [
  'Accessibility',
  'Physical / Safety',
  'Functional',
  'Safety / Code',
  'Design / Coordination',
];

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
  const response = await apiFetch(path, { cache: 'no-store' });
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

/** One handoff: from this moment, the ball is in the named party's court. */
export interface BallInCourt {
  id: string;
  registerEntryId: string;
  party: string;
  /** Whether that party is us. The fact the clock will read (issue #15). */
  inOurCourt: boolean;
  heldSince: string;
  createdAt: string;
  /**
   * The person it came to, where it came to us, and null where it went out to
   * another party (issue #112). A party is not a user.
   */
  user: User | null;
}

export interface RegisterEntry {
  id: string;
  registerId: string;
  /** Whose log it is in, and whose job — both read off the register. */
  kind: RegisterKind;
  projectId: string;
  /** What it is filed under. The engineer's, never allocated. */
  number: string;
  subject: string;
  fromParty: string;
  toParty: string;
  /** Both null on a submittal; the response lands after the question. */
  question: string | null;
  response: string | null;
  /** The issuance that answered it, if one has. */
  submissionId: string | null;
  /** The contractual turnaround in whole days, or none set (story 73). */
  turnaroundDays: number | null;
  /** The outcome of a review and the day it was reached; both or neither. */
  disposition: Disposition | null;
  disposedAt: string | null;
  /** The round this one follows, and the one that followed it (story 77). */
  previousRoundId: string | null;
  nextRoundId: string | null;
  createdAt: string;
  /** Whose move it is now: the last handoff, derived and stored nowhere. */
  ballInCourt: BallInCourt | null;
  /**
   * Elapsed in-court time in milliseconds: the sum of the intervals the ball
   * was ours, derived on every read. The badge and the clock screen read the
   * same number, so they cannot disagree about the same entry.
   */
  inCourtMs: number;
  /** Sitting in our court, with a target, and over it (stories 43, 74). */
  pastClock: boolean;
  /** Every handoff, in the order the ball moved. This list is the history. */
  handoffs: BallInCourt[];
  /** What is being chased for this entry, oldest first. */
  openItems: OpenItem[];
}

/**
 * The closed-set outcome of a submittal review (story 75).
 *
 * The words themselves and never a code: one string is stored, sent, selected
 * and printed, which is why the API keeps this as text with a CHECK rather
 * than a database enum (ADR-0036).
 */
export const DISPOSITIONS = [
  'Approved',
  'Approved as Noted',
  'Revise and Resubmit',
  'Rejected',
  'For Record Only',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/** The one that brings a submittal back for another round (story 77). */
export const REVISE_AND_RESUBMIT: Disposition = 'Revise and Resubmit';

/** An entry on the clock, carrying the job it is on. Exposure's shape. */
export interface ClockRow extends RegisterEntry {
  project: ProjectStub;
}

export type RegisterKind = 'SUBMITTAL' | 'RFI';

export interface Register {
  id: string;
  projectId: string;
  kind: RegisterKind;
  createdAt: string;
  entries: RegisterEntry[];
}

/**
 * What each log is called on screen.
 *
 * The register's kind names what an entry *is* — the column holds `RFI` and
 * the render supplies the rest, which is ADR-0030's floor rule and the one
 * ADR-0035 printed `Issue N` by.
 */
export const REGISTER_NAMES: Record<RegisterKind, string> = {
  SUBMITTAL: 'Submittals',
  RFI: 'RFIs',
};

/**
 * The clock: every entry sitting in our court past its turnaround, longest
 * first, across every live project or within one (ADR-0016).
 *
 * The count is `.length`. There is no separate count call, so the number on a
 * screen and the rows it links to cannot disagree — and there is nothing in
 * the payload to combine with exposure into a score.
 */
export function listClock(
  projectId?: string,
  mine = false,
): Promise<ClockRow[]> {
  return read<ClockRow[]>(daily('/clock', projectId, mine));
}

/** Both logs for a job, submittals first. There are always exactly two. */
export function listRegisters(projectId: string): Promise<Register[]> {
  return read<Register[]>(`/projects/${projectId}/registers`);
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getRegister(id: string): Promise<Register | undefined> {
  const path = `/registers/${id}`;
  const response = await apiFetch(path, { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<Register>;
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getRegisterEntry(
  id: string,
): Promise<RegisterEntry | undefined> {
  const path = `/register-entries/${id}`;
  const response = await apiFetch(path, { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<RegisterEntry>;
}

/** One immutable revision of a document. Never its storage key. */
export interface DocumentVersion {
  id: string;
  documentId: string;
  /** The designation printed on the sheet — "C", "Rev 2", "Addendum 1". */
  revision: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
}

/** A document stored against a job, with every version it has ever had. */
export interface StoredDocument {
  id: string;
  projectId: string;
  title: string;
  /** Stored and linked but deliberately not parsed. Stamped once (issue #17). */
  referencedFile: boolean;
  createdAt: string;
  versions: DocumentVersion[];
}

/** A version read through what points at it, carrying its document. */
export interface LinkedDocumentVersion extends DocumentVersion {
  document: {
    id: string;
    projectId: string;
    title: string;
    referencedFile: boolean;
    createdAt: string;
  };
}

/** What a document is called on screen, by what may be done to it. */
export function documentKind(document: { referencedFile: boolean }): string {
  return document.referencedFile ? 'Referenced file' : 'Document';
}

/**
 * What is stored against a job. Retrieval is by identity — through the
 * project, the submission or the entry the document belongs to — and there is
 * no search box anywhere in this product (ADR-0019).
 */
export function listDocuments(projectId: string): Promise<StoredDocument[]> {
  return read<StoredDocument[]>(`/projects/${projectId}/documents`);
}

/**
 * The documents extraction may be pointed at: every one that is not a
 * referenced file (ADR-0039).
 *
 * The same predicate the write refuses on, read rather than re-stated here —
 * a screen that filtered `listDocuments` itself would be a second place the
 * rule lives, free to disagree with the API that enforces it.
 */
export function listExtractionTargets(
  projectId: string,
): Promise<StoredDocument[]> {
  return read<StoredDocument[]>(`/projects/${projectId}/extraction-targets`);
}

/** What this issuance's sheet list points at (story 95). */
export function listSubmissionDocuments(
  submissionId: string,
): Promise<LinkedDocumentVersion[]> {
  return read<LinkedDocumentVersion[]>(`/submissions/${submissionId}/documents`);
}

/** What this piece of correspondence arrived with, or was answered by. */
export function listRegisterEntryDocuments(
  entryId: string,
): Promise<LinkedDocumentVersion[]> {
  return read<LinkedDocumentVersion[]>(`/register-entries/${entryId}/documents`);
}

// ── Project memory (issue #18) ───────────────────────────────────────────

/** A project's memory: the latest version's content, and its size budget. */
export interface ProjectMemory {
  projectId: string;
  /** Null until the first version is written. */
  content: string | null;
  versions: number;
  size: number;
  budget: number;
  versionedAt: string | null;
}

/** One state of a project's memory, oldest first as the history lists it. */
export interface MemoryVersion {
  id: string;
  projectId: string;
  content: string;
  proposalId: string | null;
  createdAt: string;
}

/** A run of the agent, with its state derived from the four stamps. */
export interface MemoryRun {
  id: string;
  projectId: string;
  runningSince: string | null;
  finishedAt: string | null;
  failedAt: string | null;
  failure: string | null;
  createdAt: string;
  state: 'queued' | 'running' | 'finished' | 'failed';
}

/** A proposed memory edit. Pending is both stamps null. */
export interface MemoryProposal {
  id: string;
  projectId: string;
  runId: string;
  /** What the memory said when the proposal was written — the diff's base. */
  baseContent: string | null;
  proposed: string;
  createdAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  state: 'pending' | 'accepted' | 'rejected';
  /**
   * The memory has moved since `baseContent` was snapshotted, so the diff
   * below no longer describes what accepting would commit — and the API
   * refuses it (issue #42). Only a pending proposal is ever stale.
   */
  stale: boolean;
}

/**
 * Which kind of record a line is about (issue #111). The closed set the API
 * spells at each of its sixty-seven call sites; `subjectHref` in
 * `app/subject-link.ts` is what turns one into a screen.
 */
export type SubjectType =
  | 'project'
  | 'phase'
  | 'submission'
  | 'open-item'
  | 'assumption-record'
  | 'site-visit'
  | 'site-visit-floor'
  | 'observation'
  | 'issue'
  | 'photo'
  | 'turn'
  | 'site-visit-report'
  | 'register-entry'
  | 'document'
  | 'document-version'
  | 'ingested-document'
  | 'extraction'
  | 'memory-version'
  | 'memory-proposal'
  | 'agent-run'
  | 'user';

/** One line of the append-only audit record, oldest first. */
export interface AuditEntry {
  id: string;
  projectId: string;
  /**
   * Who recorded it, by name (issue #111, ADR-0055). **Null** on the three
   * lines nobody presented a session for — the ingest webhook and the two
   * machine commands — and on every line written before the column existed.
   */
  actor: { id: string; name: string } | null;
  /**
   * The run it was written during. An agent is never an actor: a run acts
   * under the person who started it, so `actor` is that person and this says
   * which run they were in. Never the session the run held.
   */
  run: { type: 'agent-run' | 'extraction'; id: string } | null;
  /** Which row it is about. Null only on lines that predate issue #111. */
  subject: { type: SubjectType; id: string } | null;
  action: string;
  detail: string;
  createdAt: string;
}

/** The runs and proposals together, which is what the stream pushes. */
export interface MemoryActivity {
  runs: MemoryRun[];
  proposals: MemoryProposal[];
}

/**
 * The memory of one job, reached through the job and nothing else
 * (story 102, ADR-0019). The size and budget ride on every read so the
 * interface can push back as the document fills (story 101).
 */
export function getMemory(projectId: string): Promise<ProjectMemory> {
  return read<ProjectMemory>(`/projects/${projectId}/memory`);
}

/** What the memory has ever said, oldest first. */
export function listMemoryVersions(
  projectId: string,
): Promise<MemoryVersion[]> {
  return read<MemoryVersion[]>(`/projects/${projectId}/memory/versions`);
}

/** This job's runs, oldest first. */
export function listMemoryRuns(projectId: string): Promise<MemoryRun[]> {
  return read<MemoryRun[]>(`/projects/${projectId}/memory/runs`);
}

/** This job's proposals, pending and resolved alike. */
export function listMemoryProposals(
  projectId: string,
): Promise<MemoryProposal[]> {
  return read<MemoryProposal[]>(`/projects/${projectId}/memory/proposals`);
}

/** The audit of every memory mutation, in the order it happened. */
export function listMemoryAudit(projectId: string): Promise<AuditEntry[]> {
  return read<AuditEntry[]>(`/projects/${projectId}/memory/audit`);
}

/**
 * What happened on this job lately: the same rows, newest first and bounded
 * (story 107, ADR-0048).
 *
 * A read over the audit and never a second stream — the two answers differ in
 * their order and their bound, not in where they come from. No `limit` is
 * passed and none is offered: the route's default is what "lately" is, and its
 * maximum of 200 is load-bearing rather than a page size, so a screen that
 * walked it would collapse story 107's two questions back into one. Asking for
 * all of it means the audit read, which is where all of it lives.
 *
 * The result is a list whose **length is not a count**, unlike exposure's and
 * the clock's: it is bounded, so its length is the bound or less. Never render
 * it as a figure.
 */
export function listActivity(projectId: string): Promise<AuditEntry[]> {
  return read<AuditEntry[]>(`/projects/${projectId}/activity`);
}

// ── What has arrived from outside (issue #19) ────────────────────────────────

export interface IngestedDocumentFile {
  id: string;
  ingestedDocumentId: string;
  filename: string;
  /** What the sender claimed it is. Kept as data, never trusted as a type. */
  contentType: string;
  byteSize: number;
  createdAt: string;
}

/**
 * A document that arrived from outside, before anything has read it.
 *
 * Deliberately not a `StoredDocument`: it has no title, no revision and no
 * referenced-file answer, and all three are extraction's to propose and the
 * engineer's to confirm (ADR-0042). The envelope is null on the manual path
 * and the note is null on the mail path.
 */
export interface IngestedDocument {
  id: string;
  projectId: string;
  source: 'EMAIL' | 'MANUAL';
  arrivedAt: string;
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  body: string | null;
  note: string | null;
  files: IngestedDocumentFile[];
}

/** Reached through the job, as everything else here is (ADR-0019). */
export function listIngestedDocuments(
  projectId: string,
): Promise<IngestedDocument[]> {
  return read<IngestedDocument[]>(`/projects/${projectId}/ingested-documents`);
}

// ── Extraction to a draft, human-confirmed (issue #20) ───────────────────────

/**
 * One extraction: a run over one untrusted source that proposed the typed
 * fields of a register entry, and the engineer's answer to that proposal.
 *
 * The state is derived on every read from the stamps — there is no status
 * column (ADR-0043). `pending` is the one awaiting the engineer; `finished`
 * is the honest "the agent found no correspondence here".
 */
export interface Extraction {
  id: string;
  projectId: string;
  ingestedDocumentFileId: string | null;
  documentVersionId: string | null;
  runningSince: string | null;
  finishedAt: string | null;
  failedAt: string | null;
  failure: string | null;
  proposedKind: 'SUBMITTAL' | 'RFI' | null;
  proposedAt: string | null;
  proposedNumber: string | null;
  proposedSubject: string | null;
  proposedFromParty: string | null;
  proposedToParty: string | null;
  proposedQuestion: string | null;
  proposedResponse: string | null;
  proposedTurnaroundDays: number | null;
  proposedParty: string | null;
  proposedInOurCourt: boolean | null;
  /** A date, `YYYY-MM-DD`, and not an instant: never read it in a zone (issue #154). */
  proposedHeldSince: string | null;
  proposedTitle: string | null;
  proposedRevision: string | null;
  confirmedAt: string | null;
  registerEntryId: string | null;
  rejectedAt: string | null;
  createdAt: string;
  /** The source named by filename; the envelope when it arrived by mail. */
  source:
    | {
        filename: string;
        envelope: {
          sender: string | null;
          subject: string | null;
          body: string | null;
        };
      }
    | { filename: string; document: { id: string; title: string } };
  state:
    | 'queued'
    | 'running'
    | 'failed'
    | 'finished'
    | 'pending'
    | 'confirmed'
    | 'rejected';
}

/** The detail read adds what the OCR step read — what the review is against. */
export interface ExtractionDetail extends Extraction {
  ocrText: string | null;
}

/** What the extraction stream pushes: the whole list, on every change. */
export interface ExtractionActivity {
  extractions: Extraction[];
}

export function listExtractions(projectId: string): Promise<Extraction[]> {
  return read<Extraction[]>(`/projects/${projectId}/extractions`);
}

/** Undefined rather than throwing, so the page can render a 404. */
export async function getExtraction(
  id: string,
): Promise<ExtractionDetail | undefined> {
  const path = `/extractions/${id}`;
  const response = await apiFetch(path, { cache: 'no-store' });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath(path)} returned ${response.status}`);
  }
  return response.json() as Promise<ExtractionDetail>;
}

/** A person at the firm, as every read of one returns them (issue #105). */
export interface User {
  id: string;
  name: string;
  email: string;
}

/**
 * Which theme an engineer reads the product in (issue #117). *System* is the
 * absence of an override, which leaves `prefers-color-scheme` to answer.
 */
export type Theme = 'SYSTEM' | 'LIGHT' | 'DARK';

/**
 * The signed-in person, who is the one person a read returns a theme for.
 *
 * Separate from `User` and not a fourth field on it: a walk's conducted-by, an
 * item's owner and the people list are all `User`, and none of them is a
 * preference of the person reading the screen.
 */
export interface SignedInUser extends User {
  theme: Theme;
}

/**
 * Who this request is signed in as, or undefined when it is signed in as
 * nobody — which is what the header renders on the sign-in screen itself.
 */
export async function currentUser(): Promise<SignedInUser | undefined> {
  const response = await apiFetch('/sessions/current', {
    cache: 'no-store',
    refusal: 'answer',
  });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GET ${apiPath('/sessions/current')} returned ${response.status}`);
  }
  return response.json() as Promise<SignedInUser>;
}

/**
 * Where the engineer signing in actually is, as a header to pass on, or
 * nothing (issue #125, ADR-0062).
 *
 * `next/headers` is imported here rather than at the top of the file for the
 * reason `apiFetch` imports `cookies` inside itself: this module is read by
 * client components too, and a top-level server-only import puts it in the
 * browser's graph, which Turbopack refuses to build.
 *
 * One header and no fallback, for the reason `session.ts` gives: the one Fly
 * sets is the proxy's word, and the obvious alternative is a browser's. An
 * absent or empty value is no source at all rather than a made-up one — the
 * API reads that as null and counts the address alone, which is the half that
 * bounds a guess at an actual account.
 */
async function signInSource(): Promise<Record<string, string>> {
  const { headers } = await import('next/headers');
  const value = (await headers()).get(SOURCE_HEADER);

  return value === null || value.trim() === ''
    ? {}
    : { [SIGN_IN_SOURCE_HEADER]: value.trim() };
}

/**
 * Sign in. Answers the session id, or undefined for every way of not being an
 * account here — the API says one sentence for all of them and so does this.
 */
export async function createSession(
  email: string,
  password: string,
): Promise<string | undefined> {
  const response = await apiFetch('/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Where the engineer is, forwarded on this call and on no other
      // (issue #125, ADR-0062). The throttle in front of the sign-in route
      // counts refused attempts per source as well as per address, and this
      // is the only side of the wire that can know one: the API binds
      // loopback and every request it sees comes from this server.
      ...(await signInSource()),
    },
    body: JSON.stringify({ email, password }),
    // Made with no session on purpose; a 401 here is the answer, not a
    // reason to send anybody anywhere.
    refusal: 'answer',
  });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`POST ${apiPath('/sessions')} returned ${response.status}`);
  }
  return ((await response.json()) as { id: string }).id;
}

/** Sign out: revoke this session and no other. */
export async function revokeSession(): Promise<void> {
  const response = await apiFetch('/sessions/current', { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(
      `DELETE ${apiPath('/sessions/current')} returned ${response.status}`,
    );
  }
}

export async function listUsers(): Promise<User[]> {
  const response = await apiFetch('/users', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${apiPath('/users')} returned ${response.status}`);
  }
  return response.json() as Promise<User[]>;
}
