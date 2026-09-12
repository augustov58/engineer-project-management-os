/**
 * The machine command: make the first account, and reset any account's
 * password (issue #105, ADR-0055 part 7).
 *
 * Accounts are **recorded, not prevented**. After the first one exists, any
 * signed-in engineer adds the next through `POST /v1/users` — so this is not
 * an administration tool that grows. It is the two things a running deployment
 * cannot do for itself: exist at all, and recover an account whose password is
 * gone. A reset over mail is its own consent case and is deferred with a named
 * trigger; until then the way back in is somebody at a laptop, which is what
 * this is.
 *
 *     pnpm --filter api user create "Ada Lovelace" ada@example.com
 *     pnpm --filter api user reset ada@example.com
 *
 * On the deployment, through `scripts/user.sh` (README says how).
 *
 * The password is **never an argument**: argv is in the shell's history, in
 * `ps`, and in the process list of every other user on the machine. It is read
 * from the terminal with the echo off, or from a pipe when there is no
 * terminal — so the scripted form is `printf %s "$PASSWORD" | … create …`.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { createRuntime } from './runtime.js';
import { MINIMUM_PASSWORD_LENGTH } from './passwords.js';
import { systemTimeSource } from './time-source.js';
import { createUser, enableUser, resetPassword } from './users.js';

const USAGE = `usage:
  user create "<name>" <email>   add a user
  user reset <email>             set a user's password
  user enable <email>            re-enable a user that was disabled

The password is read from the terminal, or from stdin when piped. It is never
an argument.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Typed with the echo off, or piped in whole when there is no terminal. */
async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  // Nothing is echoed while the answer is being typed. The prompt itself is
  // written once, by hand, because muting swallows that too.
  process.stdout.write(prompt);
  const muted = rl as unknown as { _writeToOutput: (text: string) => void };
  muted._writeToOutput = () => {};
  try {
    const answer = await rl.question('');
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

async function password(): Promise<string> {
  const chosen = await readPassword('password: ');
  if (chosen.length < MINIMUM_PASSWORD_LENGTH) {
    fail(`a password is at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }
  if (process.stdin.isTTY) {
    const again = await readPassword('again: ');
    if (again !== chosen) {
      fail('those did not match');
    }
  }
  return chosen;
}

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    fail('DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env.');
  }
  return url;
}

const [command, ...rest] = process.argv.slice(2);

if (command !== 'create' && command !== 'reset' && command !== 'enable') {
  fail(USAGE);
}

// The runtime, for its Prisma client alone: the queue and the object store are
// built with it and closed with it, which costs a Redis connection this command
// does not use and keeps one place where connections are made.
const runtime = createRuntime({
  databaseUrl: databaseUrl(),
  redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  queueName: 'epmos',
  objectStoreDir: process.env['OBJECT_STORE_DIR'] ?? '.object-store',
});

try {
  const at = systemTimeSource.now();

  if (command === 'create') {
    const [name, email] = rest;
    if (name === undefined || email === undefined || rest.length !== 2) {
      fail(USAGE);
    }
    const chosen = await password();
    const user = await runtime.prisma.$transaction((tx) =>
      createUser(tx, { name, email, password: chosen }, at),
    );
    process.stdout.write(`${user.name} <${user.email}> can sign in.\n`);
  } else if (command === 'enable') {
    const [email] = rest;
    if (email === undefined || rest.length !== 1) {
      fail(USAGE);
    }
    // No password: this is the way back from a closed account, including the
    // case where the closed account was the last one and nobody can reach the
    // interface at all.
    const enabled = await runtime.prisma.$transaction((tx) =>
      enableUser(tx, email, at),
    );
    if (!enabled) {
      fail(`no account here is ${email}, or it was never closed`);
    }
    process.stdout.write(`${email} can sign in again.\n`);
  } else {
    const [email] = rest;
    if (email === undefined || rest.length !== 1) {
      fail(USAGE);
    }
    const chosen = await password();
    const reset = await runtime.prisma.$transaction((tx) =>
      resetPassword(tx, email, chosen, at),
    );
    if (!reset) {
      fail(`no account here is ${email}`);
    }
    process.stdout.write(
      `${email} has a new password, and every session of theirs is revoked.\n`,
    );
  }
} finally {
  await runtime.close();
}
