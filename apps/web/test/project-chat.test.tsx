import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import { askOnProject } from '../app/actions';

/**
 * The project chat's one server action (issue #121).
 *
 * What is asserted here is the rule that was broken and is not visible in a
 * render: **a retry after a lost response must not open a second
 * conversation.** `askOnProject` is bound with the conversation the page knew
 * about when it rendered, and a send that failed does not re-render it — so the
 * retry arrives with `null` again. Opening on the strength of that argument
 * alone put the same words on a second conversation, where the key is unique
 * per conversation and the resend rule could not fire: two turns saying the
 * same thing, two paid runs, and the first conversation hidden behind the
 * newest-first read.
 *
 * Neither `tsc` nor a screenshot catches that: both attempts succeed, and the
 * screen looks exactly as it should.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    apiFetch: vi.fn(),
    listProjectConversations: vi.fn(),
  };
});

const PROJECT = 'project-1';

/** Every call the action made, in order, as method and path. */
let sent: { method: string; path: string; body: unknown }[];

function answer(status: number, body: unknown): Response {
  return {
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  sent = [];
  vi.mocked(api.listProjectConversations).mockResolvedValue([]);
  vi.mocked(api.apiFetch).mockImplementation(async (path, init) => {
    const method = init?.method ?? 'GET';
    sent.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (path.endsWith('/conversations')) {
      return answer(201, { id: 'conversation-1' });
    }
    return answer(201, { id: 'turn-1' });
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function asked(text: string, captureKey: string): FormData {
  const form = new FormData();
  form.set('text', text);
  form.set('captureKey', captureKey);
  return form;
}

test('the first question opens a conversation and asks on it', async () => {
  const state = await askOnProject(
    PROJECT,
    null,
    { added: 0 },
    asked('what is exposed?', 'a-key-00000000'),
  );

  expect(state).toEqual({ added: 1 });
  expect(sent.map((one) => `${one.method} ${one.path}`)).toEqual([
    `POST /projects/${PROJECT}/conversations`,
    'POST /conversations/conversation-1/turns',
  ]);
  // The key the box minted, sent as it stands — the resend rule's whole
  // mechanism, and never re-minted here.
  expect(sent[1]?.body).toEqual({
    captureKey: 'a-key-00000000',
    text: 'what is exposed?',
  });
});

test('a retry after a lost response asks on the conversation already opened', async () => {
  // The first attempt landed; only its response was lost, so the page never
  // re-rendered and the action is still bound with `null`.
  vi.mocked(api.listProjectConversations).mockResolvedValue([
    { id: 'conversation-1' } as api.Conversation,
  ]);

  await askOnProject(
    PROJECT,
    null,
    { added: 0 },
    asked('what is exposed?', 'a-key-00000000'),
  );

  // No second conversation. The turn lands on the first one under the same
  // key, which the API answers with the row it already has.
  expect(sent.map((one) => `${one.method} ${one.path}`)).toEqual([
    'POST /conversations/conversation-1/turns',
  ]);
});

test('a job with several conversations asks on the newest', async () => {
  // The read is newest-first, which is the order the API answers in.
  vi.mocked(api.listProjectConversations).mockResolvedValue([
    { id: 'conversation-9' } as api.Conversation,
    { id: 'conversation-1' } as api.Conversation,
  ]);

  await askOnProject(PROJECT, null, { added: 0 }, asked('and now?', 'b-key-00000000'));

  expect(sent.map((one) => one.path)).toEqual([
    '/conversations/conversation-9/turns',
  ]);
});

test('the id the page knew is used as it stands, with no read at all', async () => {
  await askOnProject(
    PROJECT,
    'conversation-7',
    { added: 3 },
    asked('what is past its clock?', 'c-key-00000000'),
  );

  expect(api.listProjectConversations).not.toHaveBeenCalled();
  expect(sent.map((one) => one.path)).toEqual([
    '/conversations/conversation-7/turns',
  ]);
});

test('a refused send leaves the count where it was, so the box keeps the words', async () => {
  vi.mocked(api.apiFetch).mockResolvedValue(
    answer(409, { message: 'that conversation is on a site visit' }),
  );

  const state = await askOnProject(
    PROJECT,
    'conversation-7',
    { added: 3 },
    asked('what is exposed?', 'd-key-00000000'),
  );

  // `added` unchanged is what `TypeATurn` reads as *not sent*: the words and
  // the key stay in the box, which is the other half of the resend rule.
  expect(state).toEqual({
    added: 3,
    error: 'that conversation is on a site visit',
  });
});
