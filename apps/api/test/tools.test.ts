/**
 * The helper registry and the one route that drives it (issue #107, ADR-0053
 * and its correction of 2026-09-11).
 *
 * What is asserted here is the registry's shape, the blocks arriving verbatim,
 * every way a run can fail carrying its own sentence, and that the route writes
 * nothing. That the route sits **behind the gate** is asserted nowhere in this
 * file on purpose: `gate.test.ts` sweeps every route Fastify registered and this
 * one is covered by it without a line changing, which is the reason ADR-0053
 * gives for a helper being a route of ours at all.
 */

import { afterEach, expect, test } from 'vitest';
import { helperTools } from '../src/agent.js';
import {
  argvFor,
  blocksOf,
  readHelpers,
  registry,
  runHelper,
  WALL_CLOCK_MS,
} from '../src/helpers.js';
import {
  createProject,
  startTestApi,
  type AuditEntryResponse,
  type TestApi,
} from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function api(options: Parameters<typeof startTestApi>[0] = {}) {
  const app = await startTestApi({ worker: false, ...options });
  started.push(app);
  return app;
}

const FIXTURES = new URL('./helper-fixtures/', import.meta.url);

/** The transformer helper's own documented usage example. */
const A_TRANSFORMER = {
  loadKva: 65,
  primaryV: 480,
  primaryPhase: 3,
  secondaryV: 208,
  secondaryPhase: 3,
  secondaryOcpd: 'yes',
  panelBus: 225,
  spare: 0,
  conductor: 'cu',
  secLength: 8,
};

interface HelperResponse {
  helper: string;
  assumptions: string;
  flags: string;
  output: string;
}

async function ask(app: TestApi, name: string, args: unknown) {
  return app.fetch(`/v1/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
}

// ---------------------------------------------------------------- the registry

test('the three helpers that print the two blocks are registered, and the generator is not', () => {
  const { helpers, unregistered } = registry();

  expect(helpers.map((found) => found.manifest.name)).toEqual([
    'short-circuit',
    'transformer-sizing',
    'voltage-drop',
  ]);

  // Not an oversight and not a bug in the pin: `generator-sizing` prints a JSON
  // dict and a summary rather than the two blocks, so it ships in the submodule
  // carrying no manifest and is registered the day it prints them.
  expect(unregistered).toEqual([
    { directory: 'generator-sizing', reason: 'it carries no manifest' },
  ]);
});

test('every registered manifest carries the six things a manifest is', () => {
  for (const { manifest } of registry().helpers) {
    expect(manifest.name).not.toBe('');
    expect(manifest.computes).not.toBe('');
    expect(manifest.entry).not.toBe('');
    expect(manifest.arguments.passing).toBe('flags');
    expect(manifest.arguments.schema['type']).toBe('object');
    expect(manifest.record).toBe('blocks');
    expect(manifest.test).not.toBe('');
  }
});

test('a directory whose manifest this product cannot use is not registered, and the reason says why', () => {
  const { helpers, unregistered } = readHelpers(FIXTURES);

  expect(helpers.map((found) => found.manifest.name).sort()).toEqual([
    'silent',
    'slow',
  ]);

  const reasons = Object.fromEntries(
    unregistered.map((one) => [one.directory, one.reason]),
  );
  expect(reasons['misnamed']).toBe(
    'its manifest is named something-else and its directory is misnamed',
  );
  expect(reasons['no-manifest']).toBe('it carries no manifest');
  expect(reasons['not-json']).toBe('its manifest is not valid JSON');
  expect(reasons['wrong-passing']).toBe(
    'its manifest passes arguments as json-file, and only flags is implemented',
  );
  expect(reasons['wrong-record']).toBe(
    'its manifest says its record is json, and only blocks is implemented',
  );
  // The one reason whose wording is a library's. It is asserted as a prefix so
  // an Ajv upgrade rewording its own message does not fail this, while a
  // manifest whose schema silently stopped being compiled still does.
  expect(reasons['bad-schema']).toContain(
    'its argument schema does not compile',
  );

  // Every directory here is accounted for, so a fixture added later without an
  // assertion fails rather than sitting unread.
  expect(Object.keys(reasons).sort()).toEqual([
    'bad-schema',
    'misnamed',
    'no-manifest',
    'not-json',
    'wrong-passing',
    'wrong-record',
  ]);
});

test('a directory that is not there at all is an empty registry, not a crash', () => {
  // The state a `fly deploy` from a tree without `git submodule update --init`
  // is in. `POST /v1/tools/:name` answers a sentence naming it rather than "no
  // helper with that name", which would send a reader looking for a typo — that
  // branch is not driven end to end here, because the deployment's registry is
  // read once from a fixed directory and there is no seam to point it elsewhere
  // that is not machinery for the test alone. This is its precondition.
  expect(readHelpers(new URL('./no-such-directory/', import.meta.url))).toEqual({
    helpers: [],
    unregistered: [],
  });
});

test('a property becomes the flag its script takes, and a false boolean becomes no flag at all', () => {
  expect(
    argvFor({ perPhase: 6, primaryTap: true, select: false, pf: 0.8 }),
  ).toEqual(['--per-phase', '6', '--pf', '0.8', '--primary-tap']);
});

// ------------------------------------------------------------ the two blocks

test('a helper answers with the two blocks exactly as it printed them', async () => {
  const app = await api();

  const response = await ask(app, 'transformer-sizing', A_TRANSFORMER);
  expect(response.status).toBe(200);
  const body = (await response.json()) as HelperResponse;

  expect(body.helper).toBe('transformer-sizing');

  // Verbatim means verbatim: each block is a run of lines lifted out of the
  // report with nothing trimmed, so the sigils and their two leading spaces are
  // still there and the report still contains the block character for
  // character. Nothing here parses a `- ` or a `! ` (ADR-0029).
  expect(body.output).toContain(`ASSUMPTIONS:\n${body.assumptions}\n`);
  expect(body.output).toContain(`FLAGS / VERIFY:\n${body.flags}\n`);
  expect(body.assumptions).toContain('\n  - ');
  expect(body.flags.startsWith('  ! ')).toBe(true);

  // The engineering content is the helper's and is asserted by the helper's own
  // test command, not here. These two are what the route is for: the arguments
  // reached the script, and the answer came back whole.
  expect(body.output).toContain('75 kVA');
  expect(body.assumptions).toContain('demand 65.0 kVA -> next std 75 kVA');
});

test('the blocks are found by their headers and never by the sigils', () => {
  const printed = [
    '==================',
    'ASSUMPTIONS:',
    '  - one',
    '  * not a sigil this product knows, and kept anyway',
    'FLAGS / VERIFY:',
    '  (none -- every check in this script passed)',
    '==================',
    'NOTE: something after the rule',
  ].join('\n');

  expect(blocksOf(printed)).toEqual({
    assumptions: '  - one\n  * not a sigil this product knows, and kept anyway',
    flags: '  (none -- every check in this script passed)',
  });
  expect(blocksOf('a report with neither header')).toBe(null);
});

test('the other two helpers answer with their blocks too', async () => {
  const app = await api();

  const shortCircuit = await ask(app, 'short-circuit', {
    kva: 1500,
    percentZ: 3.5,
    secondaryV: 480,
    lengthFt: 25,
    size: '500',
    conductor: 'cu',
    perPhase: 6,
    motorFla: 1804.3,
  });
  expect(shortCircuit.status).toBe(200);
  const fault = (await shortCircuit.json()) as HelperResponse;
  expect(fault.assumptions).not.toBe('');
  expect(fault.output).toContain('SHORT-CIRCUIT');

  const voltageDrop = await ask(app, 'voltage-drop', {
    amps: 200,
    lengthFt: 300,
    voltage: 208,
    conductor: 'al',
    select: true,
    limitPercent: 3,
  });
  expect(voltageDrop.status).toBe(200);
  const drop = (await voltageDrop.json()) as HelperResponse;
  expect(drop.assumptions).not.toBe('');
  expect(drop.output).toContain('VOLTAGE DROP REPORT');
});

// ------------------------------------------------------------- the refusals

test('a name no manifest claims is a refusal', async () => {
  const app = await api();

  const response = await ask(app, 'wire-sizing', { amps: 40 });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no helper with that name' });
});

test('the named helper schema is what a body is validated against', async () => {
  const app = await api();

  // A field no manifest declares. `additionalProperties: false` in the
  // manifest's own schema is what refuses it, and the boundary's ajv is set to
  // fail rather than strip (ADR-0033), so it cannot vanish into a run.
  const unknown = await ask(app, 'voltage-drop', {
    amps: 40,
    lengthFt: 180,
    voltage: 240,
    size: '6',
    reticulatingSplines: true,
  });
  expect(unknown.status).toBe(400);
  expect(((await unknown.json()) as { message: string }).message).toContain(
    'not arguments for voltage-drop',
  );

  // A required argument left out.
  const incomplete = await ask(app, 'voltage-drop', { amps: 40, size: '6' });
  expect(incomplete.status).toBe(400);

  // Neither size nor select, which the script's own mutually exclusive group
  // requires one of.
  const neither = await ask(app, 'voltage-drop', {
    amps: 40,
    lengthFt: 180,
    voltage: 240,
  });
  expect(neither.status).toBe(400);

  // A string where the script takes a number. Nothing coerces it: "40" is not
  // 40 here, deliberately.
  const wrongType = await ask(app, 'voltage-drop', {
    amps: '40',
    lengthFt: 180,
    voltage: 240,
    size: '6',
  });
  expect(wrongType.status).toBe(400);

  // An enum the script would refuse anyway, refused before it is started.
  const wrongEnum = await ask(app, 'voltage-drop', {
    amps: 40,
    lengthFt: 180,
    voltage: 240,
    size: '6',
    conductor: 'unobtainium',
  });
  expect(wrongEnum.status).toBe(400);
});

test("a helper's own refusal reaches the caller as the helper wrote it", async () => {
  const app = await api();

  // Two of the four ways of stating the load. The manifest's schema requires at
  // least one and deliberately does not express "at most one": that is the
  // script's rule, argparse enforces it, and this is what it looks like when a
  // rule this product does not hold fires.
  const response = await ask(app, 'transformer-sizing', {
    ...A_TRANSFORMER,
    kva: 75,
  });
  expect(response.status).toBe(400);
  const { message } = (await response.json()) as { message: string };
  expect(message).toContain('not allowed with argument');
});

test('a helper still running at the wall-clock limit is stopped, and the limit is ten seconds', async () => {
  const slow = readHelpers(FIXTURES).helpers.find(
    (found) => found.manifest.name === 'slow',
  );
  expect(slow).toBeDefined();

  const started = Date.now();
  const result = await runHelper(slow!, {}, 250);
  expect(result.outcome).toBe('timed out');
  expect(Date.now() - started).toBeLessThan(5_000);
  if (result.outcome === 'timed out') {
    expect(result.message).toContain('was still running after 250 ms');
  }

  // The number the route runs at. ADR-0053 requires a wall-clock limit and
  // never gives one, so it is written down in exactly one place and read here.
  expect(WALL_CLOCK_MS).toBe(10_000);
});

test('a registered helper that prints no blocks is a broken helper, not an empty record', async () => {
  const silent = readHelpers(FIXTURES).helpers.find(
    (found) => found.manifest.name === 'silent',
  );
  expect(silent).toBeDefined();

  const result = await runHelper(silent!, {});
  expect(result.outcome).toBe('broken');
  if (result.outcome === 'broken') {
    expect(result.message).toBe(
      'the silent helper printed no ASSUMPTIONS: and FLAGS / VERIFY: blocks',
    );
  }
});

test('a deployment that cannot run a helper says so in a sentence', async () => {
  const app = await api();
  const path = process.env['PATH'];
  try {
    // Safe because Vitest's default pool is `forks` — this file has a process
    // to itself — its tests are sequential, and the restore below runs before
    // the test returns. Under `pool: 'threads'`, which shares `process.env`
    // across a worker's files, or if this test were made `.concurrent`, it
    // would leak an empty PATH into whatever ran beside it.
    // The subprocess is given PATH and nothing else, so emptying it is exactly
    // the deployment with no interpreter — the state ADR-0053 means by "a
    // helper the deployment cannot run is not a helper the product has".
    process.env['PATH'] = '';
    const response = await ask(app, 'transformer-sizing', A_TRANSFORMER);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message:
        'this deployment cannot run the transformer-sizing helper: python3 is not on its PATH',
    });
  } finally {
    process.env['PATH'] = path ?? '';
  }
});

// ------------------------------------------------------- it records nothing

test('asking a helper writes no row and no audit line', async () => {
  const app = await api();
  const project = await createProject(app, 'H-1', 'A job to have an audit');

  const before = await app.fetch(`/v1/projects/${project.id}/memory/audit`);
  const lines = (await before.json()) as AuditEntryResponse[];

  expect((await ask(app, 'transformer-sizing', A_TRANSFORMER)).status).toBe(200);
  expect((await ask(app, 'wire-sizing', {})).status).toBe(404);

  const after = await app.fetch(`/v1/projects/${project.id}/memory/audit`);
  expect((await after.json()) as AuditEntryResponse[]).toEqual(lines);

  // And nothing anywhere else either: the export is every row of every table,
  // so a helper run that wrote one would show up in it.
  const exported = await app.fetch('/v1/export');
  expect(exported.status).toBe(200);
  const document = JSON.stringify(await exported.json());
  expect(document).not.toContain('ASSUMPTIONS');
  expect(document).not.toContain('transformer-sizing');
});

test('reading a helper is a POST because its arguments are a body, and it creates nothing', async () => {
  const app = await api();

  const response = await ask(app, 'transformer-sizing', A_TRANSFORMER);
  // 200 and not 201: there is no location, because there is no record.
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBe(null);
});

// ------------------------------------------------------- the agent tool list

test("the agent's helper tools are the manifests and nothing else", () => {
  const calls: { path: string; body: unknown }[] = [];
  const tools = helperTools(async (path, init) => {
    calls.push({ path, body: init?.body });
    return { status: 200, body: null };
  });

  // Generated, so this list cannot drift from what the deployment can run: it
  // is the registry's names, underscored because provider APIs reject a dot
  // and the house convention is underscores (ADR-0040).
  expect(tools.map((tool) => tool.name)).toEqual([
    'short_circuit',
    'transformer_sizing',
    'voltage_drop',
  ]);
  expect(tools.map((tool) => tool.label)).toEqual(
    registry().helpers.map((found) => found.manifest.name),
  );
  expect(tools.map((tool) => tool.description)).toEqual(
    registry().helpers.map((found) => found.manifest.computes),
  );
  expect(tools.map((tool) => tool.parameters)).toEqual(
    registry().helpers.map((found) => found.manifest.arguments.schema),
  );
  expect(calls).toEqual([]);
});

test('a helper tool is a call of the route, and never a subprocess of its own', async () => {
  const calls: { path: string; method?: string; body: unknown }[] = [];
  const tools = helperTools(async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body });
    return { status: 200, body: { helper: 'voltage-drop' } };
  });

  const tool = tools.find((one) => one.name === 'voltage_drop');
  expect(tool).toBeDefined();
  await tool!.execute('a-tool-call-id', { amps: 40 });

  expect(calls).toEqual([
    { path: '/tools/voltage-drop', method: 'POST', body: { amps: 40 } },
  ]);
});
