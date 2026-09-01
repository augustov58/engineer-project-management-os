/**
 * The agent, injectable at the worker the way `Transcriber` is (ADR-0034's
 * shape), and the port ADR-0002 requires: `AgentRunService` wraps the Pi SDK
 * and **no Pi type appears outside this file**.
 *
 * The one run this product asks for is a memory proposal (issue #18). The
 * agent reads the project through domain tools — which call the internal API
 * and never the database — and its one mutating tool writes a *proposal*,
 * never memory itself. The engineer accepts, edits or rejects the proposal;
 * every word in memory is there because the engineer put it there.
 *
 * There is no offline stand-in for a model the way a filesystem stands in for
 * S3, so the default refuses and says so, which is `unconfiguredTranscriber`'s
 * posture exactly: the state the pick is actually in, exercised by the dev
 * default rather than only by a test. `AGENT=pi` builds the real adapter.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';

/** What one run is asked to do. The id and the job, and nothing else. */
export interface AgentRunRequest {
  runId: string;
  projectId: string;
}

export interface AgentRunService {
  /**
   * Runs the agent against one project and returns when it is done. The
   * proposal, if one comes, arrives *during* the run through the agent's
   * `memory_propose_edit` tool calling the internal API — so this resolves
   * with nothing, and throws what the run failed with.
   */
  proposeMemoryEdit(request: AgentRunRequest): Promise<void>;
}

/**
 * The default: there is no model provider configured, and it says so.
 *
 * A run asked for against this adapter is recorded as failed with this
 * sentence, and nothing else happened — which is the honest state of the
 * product before `AGENT=pi` and a provider credential are both present.
 */
export const unconfiguredAgentRunService: AgentRunService = {
  proposeMemoryEdit: () =>
    Promise.reject(new Error('no model provider is configured')),
};

/**
 * One call of a domain tool: the internal API, over HTTP, and never the
 * database (ADR-0002).
 *
 * The agent reaches data through the same routes the screens do, so there is
 * one set of rules about what can be read and what can change — and the one
 * mutating tool below writes a proposal, which commits nothing.
 */
type CallApi = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: unknown }>;

export function caller(apiBaseUrl: string): CallApi {
  return async (path, init) => {
    const response = await fetch(`${apiBaseUrl}/v1${path}`, {
      method: init?.method ?? 'GET',
      ...(init?.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
          }),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  };
}

/** A tool's answer is the API's, as text the model reads. */
function asResult(status: number, body: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status, body }) }],
    details: {},
  };
}

/**
 * The tool names, which are the allowlist the session is built with.
 *
 * Underscored rather than the PRD's dotted `memory.propose_edit`: the
 * provider APIs the model is actually called through reject a `.` in a tool
 * name (the names must match `^[a-zA-Z0-9_-]+$`), so the PRD's spelling is
 * one no adapter could register. Recorded in ADR-0040.
 */
const NO_PARAMS = Type.Object({});

/**
 * The domain tools one memory run is given, each a thin call of the internal
 * API. The read set is the PRD's list minus `documents.extract`, which is the
 * consent-gated step 5 and not this ticket; the draft-creating tools of that
 * list belong to the capture and ingest slices that own their records.
 */
/**
 * Exported for the test that holds the read set to what it says it returns.
 * No Pi type crosses this signature, so ADR-0040's rule that none appears
 * outside this file still holds.
 */
export function memoryRunTools(call: CallApi, runId: string, projectId: string) {
  const get = (path: string) => async () => {
    const { status, body } = await call(path);
    return asResult(status, body);
  };

  return [
    {
      name: 'projects_get',
      label: 'projects.get',
      description:
        'The project this run is about: its number, name, and whether it is archived.',
      parameters: NO_PARAMS,
      /**
       * The three fields the description names, and not the response.
       *
       * Every other tool here hands the API's answer through, and this one
       * deliberately does not: a project carries `ingestAddress` since issue
       * #19, which is the only credential on a path that bypasses the
       * interface entirely (ADR-0042) — handing it to a run would put it in a
       * model provider's context, in the proposal it wrote and in the audit.
       * Projecting here rather than adding a second project read keeps that
       * true of anything else a project grows, and makes the description above
       * a description rather than an approximation.
       */
      execute: async () => {
        const { status, body } = await call(`/projects/${projectId}`);
        if (status !== 200 || typeof body !== 'object' || body === null) {
          return asResult(status, body);
        }
        const { projectNumber, name, archivedAt } = body as Record<
          string,
          unknown
        >;
        return asResult(status, { projectNumber, name, archivedAt });
      },
    },
    {
      name: 'projects_get_exposure',
      label: 'projects.get_exposure',
      description:
        "The project's issued submissions still standing on unresolved open items.",
      parameters: NO_PARAMS,
      execute: get(`/exposure?projectId=${projectId}`),
    },
    {
      name: 'open_items_list',
      label: 'open_items.list',
      description: 'Every unresolved open item on the project.',
      parameters: NO_PARAMS,
      execute: get(`/projects/${projectId}/open-items`),
    },
    {
      name: 'submissions_list',
      label: 'submissions.list',
      description: 'Every issuance recorded on the project, with what each rested on.',
      parameters: NO_PARAMS,
      execute: get(`/projects/${projectId}/submissions`),
    },
    {
      name: 'registers_list',
      label: 'registers.list',
      description:
        'The submittals and RFIs registers with their entries and ball-in-court history.',
      parameters: NO_PARAMS,
      execute: get(`/projects/${projectId}/registers`),
    },
    {
      name: 'registers_get_clock',
      label: 'registers.get_clock',
      description:
        "Register entries sitting in our court past their turnaround, with each entry's accrued in-court time.",
      parameters: NO_PARAMS,
      execute: get(`/clock?projectId=${projectId}`),
    },
    {
      name: 'issues_list',
      label: 'issues.list',
      description: 'Every finding on the project, with its sightings.',
      parameters: NO_PARAMS,
      execute: get(`/projects/${projectId}/issues`),
    },
    {
      name: 'memory_get',
      label: 'memory.get',
      description:
        "The project's current memory and how full its size budget is. Read this before proposing.",
      parameters: NO_PARAMS,
      execute: get(`/projects/${projectId}/memory`),
    },
    {
      name: 'memory_propose_edit',
      label: 'memory.propose_edit',
      description:
        'Propose a new full text for the project memory. This writes a proposal for the engineer to accept, edit or reject; it never writes memory directly. Call it once.',
      parameters: Type.Object({
        content: Type.String({
          description: 'The whole proposed memory document, replacing the current one.',
        }),
      }),
      execute: async (_id: string, params: { content: string }) => {
        const { status, body } = await call(`/memory-runs/${runId}/proposal`, {
          method: 'POST',
          body: { content: params.content },
        });
        return asResult(status, body);
      },
    },
  ];
}

/**
 * What the run is asked to do, in words. The tools carry the mechanics; this
 * carries the judgement — what memory is for, and that it stays small.
 */
const PROMPT = `You are maintaining the project memory for one engineering project: a small piece of curated prose holding reasoning and decisions — what was decided and why — that typed records cannot carry.

Read the project with the tools you have: the project itself, its open items, submissions, registers, issues, and the current memory.

Then propose exactly one edit with memory_propose_edit. The proposal is the whole new text of the memory, not a description of a change. Keep it small: the current memory's response carries its size budget, and a proposal that grows it past the budget must say less, not more. Curate rather than accumulate — replace what is settled or stale, keep what is still load-bearing. If nothing worth recording has changed, propose the current text unchanged.

Never write to memory directly: your proposal is reviewed by the engineer, who accepts, edits or rejects it.`;

/**
 * The real adapter: one Pi `AgentSession` per run, built and disposed here,
 * with the session kept in memory — the record of the run is the `agent_runs`
 * row, not Pi's session files.
 *
 * The coding-agent primitives are off. The session is built with an explicit
 * tool allowlist naming this product's own domain tools and nothing else, so
 * no built-in is enabled — `bash`, `edit` and `write` are absent rather than
 * denied, and since this fix so are `read`, `grep`, `find` and `ls`.
 *
 * Those four were enabled here, scoped by `cwd`, until the SDK's own resolver
 * was read: `resolvePath` uses `cwd` as the base for a *relative* path only
 * and returns an absolute one as given, `~` expands to the home directory,
 * and none of the four tools carries a containment check. So `cwd` never
 * bounded them, and a run could have read the SDK's own credential store and
 * put it in a proposal. A memory run needs no file at all — every fact it
 * reads arrives over HTTP — so they are removed rather than fenced
 * (ADR-0002, story 108).
 *
 * `cwd` still points at an empty per-project directory under `workspaceRoot`,
 * so a built-in that a future SDK default enables lands there rather than in
 * the repository.
 *
 * Provider auth is the SDK's own `ModelRuntime` — server-side, from its auth
 * store or the environment. No credential is read, held or logged by this
 * product, and none crosses to the frontend: the only thing a run puts on the
 * wire is the proposal the engineer asked for (story 109).
 *
 * The SDK is imported lazily so that a process which never runs the adapter —
 * every test, which substitutes the port — never loads it.
 */
export function piAgentRunService({
  apiBaseUrl,
  workspaceRoot,
}: {
  /** Where the internal API is reachable from this process. */
  apiBaseUrl: string;
  /** The directory the per-project workspaces live under. */
  workspaceRoot: string;
}): AgentRunService {
  return {
    async proposeMemoryEdit({ runId, projectId }) {
      const sdk = await import('@earendil-works/pi-coding-agent');

      const cwd = join(workspaceRoot, projectId);
      await mkdir(cwd, { recursive: true });

      const tools = memoryRunTools(caller(apiBaseUrl), runId, projectId);
      const modelRuntime = await sdk.ModelRuntime.create();
      const { session } = await sdk.createAgentSession({
        cwd,
        sessionManager: sdk.SessionManager.inMemory(),
        modelRuntime,
        // The allowlist, which is the disabling: a tool not named here is not
        // enabled, so every built-in — shell, edit, write and the file tools
        // alike — is off by construction rather than by a denylist that a new
        // built-in would slip past.
        tools: tools.map((tool) => tool.name),
        customTools: tools.map((tool) => sdk.defineTool(tool)),
      });
      try {
        await session.prompt(PROMPT);
      } finally {
        session.dispose();
      }
    },
  };
}

/**
 * The adapter this deployment runs, read once at the boundary so nothing
 * below here asks an environment variable what it is talking to. Off unless
 * `AGENT=pi`, the way the stub transcriber is off unless named: the default
 * is the honest refusal, not a silent attempt at a vendor that is not there.
 */
export function agentRunServiceFromEnv(options: {
  apiBaseUrl: string;
  workspaceRoot: string;
}): AgentRunService {
  return process.env['AGENT'] === 'pi'
    ? piAgentRunService(options)
    : unconfiguredAgentRunService;
}
