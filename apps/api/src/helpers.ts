/**
 * The helper registry: what a helper skill is to this product, and how one runs.
 *
 * A helper is a directory under `tools/` — this repository's first non-TypeScript
 * code, a git submodule pinned by commit at the helpers' own repository
 * (ADR-0053 and its correction of 2026-09-11). A directory carrying a
 * `manifest.json` is registered and reachable as `POST /v1/tools/<name>`; a
 * directory without one is not, which is how `generator-sizing` ships here and
 * stays out until it prints the two blocks. **Adding a helper is adding a
 * directory**, and nothing in this file names one.
 *
 * A leaf, and one from its first line rather than after a move: two readers
 * reached for it before it existed — `routes/tools.ts` runs a helper, and
 * `agent.ts` generates the agent's tool list from the same manifests. It
 * imports no route module, which is ADR-0033's whole rule about leaves.
 *
 * **The product still implements no calculation logic.** Everything below moves
 * arguments to a script and text back; no number in this file is an engineering
 * number, and the two blocks are passed through exactly as printed (ADR-0029).
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv, type ValidateFunction } from 'ajv';

const run = promisify(execFile);

/**
 * Where the submodule is checked out. Resolved off this module rather than off
 * `process.cwd()`, which differs between `pnpm dev`, the image and the suite.
 */
const TOOLS_DIRECTORY = new URL('../tools/', import.meta.url);

/** The interpreter, by name and never by path: `PATH` is the whole of finding it. */
const PYTHON = 'python3';

/**
 * The wall-clock limit ADR-0053 requires and never gives a number to. Ten
 * seconds: the slowest thing registered here is the 40-case handbook harness at
 * 22 ms, so this is three orders of magnitude of headroom and still short
 * enough that a wedged subprocess is a refusal rather than a held connection.
 */
export const WALL_CLOCK_MS = 10_000;

/**
 * What one helper may print. A megabyte is far past any report these produce and
 * is `execFile`'s own default; naming it is what makes the overflow a sentence
 * rather than an unhandled error.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** The two headers the record is made of. Matched whole, and never the sigils. */
const ASSUMPTIONS_HEADER = 'ASSUMPTIONS:';
const FLAGS_HEADER = 'FLAGS / VERIFY:';

/** The rule the helpers print to close a report. It is what ends the second block. */
const RULE = /^=+$/;

/** The only way of passing arguments that is implemented. */
const FLAGS = 'flags';

/** The only thing a helper's output may be declared to be. */
const BLOCKS = 'blocks';

/**
 * What a helper directory declares about itself. Every field is required: a
 * manifest that omits one describes a helper this product cannot call, and
 * defaulting it would be guessing on the engineer's behalf.
 */
export interface HelperManifest {
  /** The directory's name, which is the path segment of `POST /v1/tools/<name>`. */
  name: string;
  /** What it computes, in a sentence — the agent reads this as the description. */
  computes: string;
  /** The script, relative to the helper's directory. */
  entry: string;
  arguments: {
    /** How the script takes them. `flags` is the only value implemented. */
    passing: string;
    /** The JSON Schema one request body is validated against. */
    schema: Record<string, unknown>;
  };
  /** Which output is the record. `blocks` is the only value implemented. */
  record: string;
  /** The command that checks it, run from the helper's own directory. */
  test: string;
}

export interface Helper {
  manifest: HelperManifest;
  /** The absolute directory. It is the cwd the subprocess is given, and all it is given. */
  directory: string;
  /**
   * The name the agent's tool list carries. Underscored, because provider APIs
   * reject a `.` and the house convention for a tool name is `^[a-z0-9_]+$`
   * (ADR-0040). The route's path segment keeps the directory's hyphens.
   */
  toolName: string;
  validate: ValidateFunction;
}

/** A directory under `tools/` that is not a helper, and why not. */
export interface UnregisteredHelper {
  directory: string;
  reason: string;
}

export interface Registry {
  helpers: Helper[];
  unregistered: UnregisteredHelper[];
}

/**
 * A validator per helper, compiled once.
 *
 * Its own Ajv rather than the one `server.ts` configures, and deliberately
 * configured differently: `coerceTypes` is off because a helper's argument is
 * whatever JSON said it was and "3" is not 3 here, and `useDefaults` is off
 * because an omitted flag is how a script's own default is asked for — filling
 * one in would send an argument the engineer did not give. `allErrors` is on so
 * a refusal names every problem rather than the first.
 */
const ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why this manifest cannot be registered, or null.
 *
 * It reads every field rather than trusting the type: a manifest arrives from a
 * pinned commit of another repository, so it is data at runtime however it is
 * declared here.
 */
function manifestProblem(value: unknown, directory: string): string | null {
  if (!isRecord(value)) {
    return 'its manifest is not a JSON object';
  }
  for (const field of ['name', 'computes', 'entry', 'record', 'test']) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      return `its manifest has no ${field}`;
    }
  }
  if (value['name'] !== directory) {
    return `its manifest is named ${String(value['name'])} and its directory is ${directory}`;
  }
  if (value['record'] !== BLOCKS) {
    return `its manifest says its record is ${String(value['record'])}, and only ${BLOCKS} is implemented`;
  }
  const args = value['arguments'];
  if (!isRecord(args)) {
    return 'its manifest has no arguments';
  }
  if (args['passing'] !== FLAGS) {
    return `its manifest passes arguments as ${String(args['passing'])}, and only ${FLAGS} is implemented`;
  }
  if (!isRecord(args['schema'])) {
    return 'its manifest has no argument schema';
  }
  return null;
}

/**
 * Read a directory of helper directories.
 *
 * Exported so a test can point it at a fixture and see a bad manifest refused;
 * the deployment's own registry is `registry()` below.
 */
export function readHelpers(root: URL): Registry {
  const helpers: Helper[] = [];
  const unregistered: UnregisteredHelper[] = [];

  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return { helpers, unregistered };
  }

  for (const directory of entries) {
    const at = new URL(`${directory}/`, root);
    if (!statSync(at, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(new URL('manifest.json', at), 'utf8');
    } catch {
      // No manifest is not a failure: it is how a helper stays out of the
      // registry while still shipping in the pinned commit.
      unregistered.push({ directory, reason: 'it carries no manifest' });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unregistered.push({ directory, reason: 'its manifest is not valid JSON' });
      continue;
    }

    const problem = manifestProblem(parsed, directory);
    if (problem !== null) {
      unregistered.push({ directory, reason: problem });
      continue;
    }

    const manifest = parsed as HelperManifest;
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(manifest.arguments.schema);
    } catch (error) {
      unregistered.push({
        directory,
        reason: `its argument schema does not compile: ${(error as Error).message}`,
      });
      continue;
    }

    helpers.push({
      manifest,
      directory: fileURLToPath(at),
      toolName: manifest.name.replaceAll('-', '_'),
      validate,
    });
  }

  return { helpers, unregistered };
}

let loaded: Registry | null = null;

/** The deployment's registry, read once. */
export function registry(): Registry {
  loaded ??= readHelpers(TOOLS_DIRECTORY);
  return loaded;
}

export function helper(name: string): Helper | undefined {
  return registry().helpers.find((found) => found.manifest.name === name);
}

/**
 * The flag a property is passed as: `perPhase` becomes `--per-phase`.
 *
 * The whole of the mapping, and it has to be: a manifest naming a property the
 * script does not take would make argparse exit 2, which reaches the caller as
 * that script's own refusal.
 */
function flag(property: string): string {
  return `--${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * One validated argument object as argv. Sorted, so the same body always
 * produces the same command; argparse does not care about order, and a test
 * reading it does.
 *
 * A `false` boolean is an omitted flag rather than `--flag false`, because the
 * flags these map to are argparse `store_true` actions that take no value.
 */
export function argvFor(args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const property of Object.keys(args).sort()) {
    const value = args[property];
    if (value === false || value === undefined) {
      continue;
    }
    argv.push(flag(property));
    if (value !== true) {
      argv.push(String(value));
    }
  }
  return argv;
}

/**
 * The two blocks, exactly as printed, or null if the output has no such shape.
 *
 * `ASSUMPTIONS:` opens the first and `FLAGS / VERIFY:` both closes it and opens
 * the second, which the helpers' closing rule of `=` ends. Nothing here reads a
 * line's content: the `- ` and `! ` sigils are the scripts' convention and not a
 * contract, and parsing them would make this refuse the next helper's output
 * (ADR-0029). The lines are sliced and joined and never trimmed.
 */
export function blocksOf(output: string): Blocks | null {
  const lines = output.split('\n');
  const opens = lines.indexOf(ASSUMPTIONS_HEADER);
  if (opens === -1) {
    return null;
  }
  const between = lines.indexOf(FLAGS_HEADER, opens + 1);
  if (between === -1) {
    return null;
  }
  let closes = between + 1;
  while (closes < lines.length && !RULE.test(lines[closes] ?? '')) {
    closes += 1;
  }
  return {
    assumptions: lines.slice(opens + 1, between).join('\n'),
    flags: lines.slice(between + 1, closes).join('\n'),
  };
}

/** The two blocks a record is made of, as printed. */
export interface Blocks {
  assumptions: string;
  flags: string;
}

export type HelperRun =
  | ({ outcome: 'ran'; output: string } & Blocks)
  /** The script exited nonzero. Its own stderr, which is usually argparse's. */
  | { outcome: 'refused'; message: string }
  /** It was still running at the wall-clock limit and was killed. */
  | { outcome: 'timed out'; message: string }
  /**
   * There is no interpreter on this deployment's `PATH`. A missing *script* is
   * not this: `python3` starts, exits 2 and says so, which is a `refused` —
   * the sentence the caller wants there is the one the interpreter wrote.
   */
  | { outcome: 'cannot run'; message: string }
  /** It ran and returned something this product cannot read as a record. */
  | { outcome: 'broken'; message: string };

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error['code'] === 'string'
    ? error['code']
    : '';
}

/**
 * Run one helper.
 *
 * The subprocess is given its own directory as its working directory, an
 * environment carrying nothing but `PATH`, and an argv built only out of values
 * its own schema accepted — so no path reaches it that it did not ship with, and
 * no shell is involved to make one. Python runs under `-I`, which ignores
 * `PYTHON*` variables and the user site directory, and `-B`, so a read-only
 * image does not fail on a bytecode write.
 *
 * **This is not a kernel-level jail, and nothing here claims one.** Its own
 * directory is the only one it is *given*; a `chroot`, a mount namespace or a
 * container would be what makes it the only one it *can reach*, and none of
 * those is in the image. ADR-0041's rule is the reason to say so plainly rather
 * than to describe this as a sandbox: a sandbox claimed for someone else's code
 * is not a sandbox until the mechanism has been read. What stands behind this
 * one is that the code is ours, pinned by commit, and reached through a schema.
 */
export async function runHelper(
  found: Helper,
  args: Record<string, unknown>,
  timeoutMs: number = WALL_CLOCK_MS,
): Promise<HelperRun> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      PYTHON,
      ['-B', '-I', found.manifest.entry, ...argvFor(args)],
      {
        cwd: found.directory,
        env: { PATH: process.env['PATH'] ?? '' },
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    ));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      return {
        outcome: 'cannot run',
        message: `this deployment cannot run the ${found.manifest.name} helper: ${PYTHON} is not on its PATH`,
      };
    }
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        outcome: 'broken',
        message: `the ${found.manifest.name} helper printed more than ${MAX_OUTPUT_BYTES} bytes`,
      };
    }
    if (isRecord(error) && error['killed'] === true) {
      return {
        outcome: 'timed out',
        message: `the ${found.manifest.name} helper was still running after ${timeoutMs} ms and was stopped`,
      };
    }
    const said =
      isRecord(error) && typeof error['stderr'] === 'string'
        ? error['stderr'].trim()
        : '';
    return {
      outcome: 'refused',
      message:
        said === ''
          ? `the ${found.manifest.name} helper refused those arguments`
          : said,
    };
  }

  const blocks = blocksOf(stdout);
  if (blocks === null) {
    return {
      outcome: 'broken',
      message: `the ${found.manifest.name} helper printed no ${ASSUMPTIONS_HEADER} and ${FLAGS_HEADER} blocks`,
    };
  }
  return { outcome: 'ran', output: stdout, ...blocks };
}

/**
 * Why a body is not arguments for this helper, as one sentence, or null.
 *
 * Ajv's messages are joined rather than sent as a list, because every other
 * refusal in this product is a `{ message }` and a second shape here would be a
 * second thing a caller has to read.
 */
export function argumentProblem(
  found: Helper,
  args: unknown,
): string | null {
  if (found.validate(args)) {
    return null;
  }
  const problems = (found.validate.errors ?? [])
    .map((error) => `${error.instancePath || 'the arguments'} ${error.message}`)
    .join('; ');
  return `those are not arguments for ${found.manifest.name}: ${problems}`;
}
