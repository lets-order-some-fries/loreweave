import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeVault } from './helpers.js';

/**
 * The stdio MCP server must leave when its client does.
 *
 * Closing stdin is how an MCP client ends a stdio session — the spec's shutdown
 * sequence is "close the server's input, wait for it to exit, then SIGTERM". The
 * SDK's StdioServerTransport listens for 'data' and 'error' on stdin and nothing
 * else, and the vault watcher holds the event loop open, so up to 0.38.0 EOF
 * changed nothing: the server sat there indefinitely. Behind mcp-proxy, a SIGTERM
 * to the proxy closed loreweave's stdin and left loreweave running as an orphan.
 *
 * These spawn the BUILT CLI, because the fault lives in process lifetime — event
 * loop, signals, stdio handles — which an in-memory transport never exercises.
 */
const CLI = join(process.cwd(), 'dist/cli/main.js');

/** Generous for a cold start on a slow CI runner, still far short of the suite timeout. */
const REPLY_MS = 15_000;
/** How long a server may take to exit once stdin has closed and nothing is owed. */
const EXIT_MS = 5_000;

type Message = { id?: number; result?: any; error?: { message: string } };

const live: ChildProcess[] = [];
/** Process groups started through a shell, killed whole: killing the shell alone orphans the server. */
const groups: number[] = [];

afterEach(() => {
  // Never leave a server behind, whatever an assertion did: a test of process
  // lifetime must not become the orphan it is testing for.
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // ESRCH: the whole group has already exited
    }
  }
});

/** `stdin: 'ignore'` starts the server on the null device: input that is over before it begins. */
function startServer(root: string, stdin: 'pipe' | 'ignore' = 'pipe') {
  const child = spawn(process.execPath, [CLI, '--vault', root, 'serve', '--mcp'], {
    stdio: [stdin, 'pipe', 'pipe'],
  });
  live.push(child);
  const messages: Message[] = [];
  let stderr = '';
  let buffered = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => (stderr += chunk));

  // 'close', not 'exit': 'close' waits until stdout and stderr have been read to
  // the end, so every reply the server wrote is in `messages` by the time a test
  // looks. 'exit' can fire with the last of them still in the pipe.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );

  const send = (msg: object) =>
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

  const reply = async (id: number): Promise<Message> => {
    const deadline = Date.now() + REPLY_MS;
    for (;;) {
      const m = messages.find((x) => x.id === id);
      if (m) return m;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited before replying to ${id}; stderr:\n${stderr}`);
      }
      if (Date.now() > deadline) throw new Error(`no reply to ${id}; stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /** Resolves with how the server exited, or kills it and says it never did. */
  const exit = async (ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    const outcome = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`server still running after ${ms}ms; stderr:\n${stderr}`);
    }
    return outcome;
  };

  const initialize = async () => {
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'eof-test', version: '1' },
      },
    });
    const r = await reply(1);
    expect(r.result?.serverInfo?.name).toBe('loreweave');
    send({ method: 'notifications/initialized' });
  };

  return { child, send, reply, exit, initialize, messages, stderr: () => stderr };
}

describe.skipIf(!existsSync(CLI))('mcp server over stdio (built CLI)', () => {
  it('exits 0 when the client closes stdin', async () => {
    const root = await makeVault({ 'note.md': '# Note\n\nSomething worth remembering.\n' });
    const server = startServer(root);
    await server.initialize();

    const closedAt = Date.now();
    server.child.stdin!.end();
    const { code, signal } = await server.exit(EXIT_MS);

    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(EXIT_MS);
  }, 30_000);

  it('still answers a request in flight when stdin closes, then exits 0', async () => {
    // A client that pipes its requests in and half-closes — `printf … | lore
    // serve --mcp`, or any harness that writes then ends — is owed every reply.
    // The reindex below awaits filesystem I/O, so it is still running when EOF
    // arrives; exiting on EOF without waiting would drop its reply on the floor.
    const notes: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      notes[`notes/n${i}.md`] = `# Note ${i}\n\nGlacier sensor reading ${i} from the meltwater survey.\n`;
    }
    const server = startServer(await makeVault(notes));
    await server.initialize();

    server.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'lore_index', arguments: { full: true } },
    });
    server.child.stdin!.end();
    const { code, signal } = await server.exit(EXIT_MS + REPLY_MS);

    expect(signal).toBeNull();
    expect(code).toBe(0);
    const r = server.messages.find((m) => m.id === 2);
    expect(r, 'the reply owed for the in-flight lore_index was never written').toBeDefined();
    expect(r!.error).toBeUndefined();
    expect(r!.result?.isError ?? false).toBe(false);
    // startup already indexed the vault, so a full pass re-reads all 40 notes
    expect(JSON.parse(r!.result.content[0].text).updated).toBe(40);
  }, 45_000);

  // POSIX only: there, writes to a pipe are asynchronous, so a reply can be
  // answered and still sitting in the process when it exits. Windows makes
  // stdout pipe writes synchronous, so nothing can be left behind to lose.
  it.skipIf(process.platform === 'win32')(
    'a client that hangs up and reads late still gets every reply',
    async () => {
      // The server's stdout is a real OS pipe that nothing reads for two
      // seconds. Nine ~10 KB replies overflow the 64 KiB pipe, and the rest
      // waits inside the server under the stream's 64 KiB high-water mark — so
      // every send has already "succeeded". Exiting once nothing is owed
      // truncates the output at exactly 65 536 bytes: measured, six whole
      // replies and the head of a seventh.
      const sentence = 'Glacier sensor reading from the meltwater survey, logged hourly. ';
      const root = await makeVault({ 'big.md': `# Big\n\n${sentence.repeat(160)}\n` });
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          `{ "${process.execPath}" "${CLI}" --vault "${root}" serve --mcp; echo "server-exit=$?" >&2; } | (sleep 2; cat)`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
      );
      groups.push(child.pid!);
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => (err += c));
      const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

      const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'late', version: '1' } },
      });
      send({ method: 'notifications/initialized' });
      const K = 9;
      for (let i = 0; i < K; i++) {
        send({ id: 100 + i, method: 'tools/call', params: { name: 'lore_read_note', arguments: { path: 'big.md' } } });
      }
      child.stdin.end();

      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        closed,
        new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), EXIT_MS + REPLY_MS))),
      ]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        process.kill(-child.pid!, 'SIGKILL');
        throw new Error(`still running after ${EXIT_MS + REPLY_MS}ms; stderr:\n${err}`);
      }

      expect(err).toContain('server-exit=0');
      expect(out.endsWith('\n'), `output ends mid-reply after ${out.length} bytes`).toBe(true);
      const ids = out
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as Message).id);
      expect(ids.filter((id) => id !== undefined && id >= 100)).toHaveLength(K);
    },
    30_000,
  );

  it('exits 0 when started with no input at all', async () => {
    // stdin on the null device — a launcher that gives the server no input, or
    // one started with stdin already closed, which Node reopens as the null
    // device at startup. The input has ended before the first read, and that is
    // a hang-up like any other: exit cleanly, neither crash nor wait forever.
    const root = await makeVault({ 'note.md': '# Note\n\nSomething worth remembering.\n' });
    const server = startServer(root, 'ignore');
    const { code, signal } = await server.exit(REPLY_MS);

    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(server.messages).toEqual([]);
  }, 30_000);
});

describe.skipIf(!existsSync(CLI))('the other ways out of the stdio server', () => {
  it('a malformed message still exits 1 and says why', async () => {
    // Unheard, the SDK skips a malformed line without a word and serves the
    // next one, so the request in it goes unanswered and nothing says why —
    // what 0.38.0 did on SDK 1.12.0–1.13.1, whose connect() replaced the
    // handlers it had set. The hang-up work rewired every exit, so this pins
    // that one.
    const root = await makeVault({ 'note.md': '# Note\n\nSomething worth remembering.\n' });
    const server = startServer(root);
    await server.initialize();

    server.child.stdin!.write('this is not json\n');
    const { code, signal } = await server.exit(EXIT_MS);

    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(server.stderr()).toContain('[loreweave mcp] transport error');
  }, 30_000);

  // Windows has no signals to catch: kill() there terminates the process outright.
  it.skipIf(process.platform === 'win32')('SIGTERM still exits 0', async () => {
    const root = await makeVault({ 'note.md': '# Note\n\nSomething worth remembering.\n' });
    const server = startServer(root);
    await server.initialize();

    server.child.kill('SIGTERM');
    const { code, signal } = await server.exit(EXIT_MS);

    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 30_000);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!existsSync(CLI))('what a hang-up must not lose', () => {
  it('indexes a note saved just before the client hangs up', async () => {
    // The watcher reindexes after 400 ms of quiet. Dropping that wait on the
    // way out lost the last edit of a session, and for good: nothing re-syncs
    // the index at the next start, so the note stayed unsearchable.
    const root = await makeVault({ 'note.md': '# Note\n\nSomething worth remembering.\n' });
    const first = startServer(root);
    await first.initialize();
    await sleep(300); // let the vault watcher attach, as tests/watch.test.ts does
    await writeFile(join(root, 'late.md'), '# Late\n\nThe zebrafinch observation, saved on the way out.\n');
    // Long enough for the change to reach the watcher, short of its 400 ms quiet period.
    await sleep(250);
    first.child.stdin!.end();
    expect((await first.exit(EXIT_MS + REPLY_MS)).code).toBe(0);

    const second = startServer(root);
    await second.initialize();
    second.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'lore_search', arguments: { query: 'zebrafinch' } },
    });
    const r = await second.reply(2);
    second.child.stdin!.end();
    await second.exit(EXIT_MS);
    expect(r.result?.content?.[0]?.text, 'the note saved before the hang-up is not searchable').toContain(
      'late.md',
    );
  }, 45_000);

  it('lets an index still running finish before it exits', async () => {
    // A cancelled lore_index is owed no reply, but nothing stops the index
    // itself. Exiting under it left the index marked interrupted, and the next
    // start rebuilt all of it before answering anything.
    const notes: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      notes[`n/n${i}.md`] = `# Note ${i}\n\nGlacier sensor reading ${i} from the meltwater survey.\n`;
    }
    const root = await makeVault(notes);
    const first = startServer(root);
    await first.initialize();
    first.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'lore_index', arguments: { full: true } },
    });
    await sleep(200);
    first.send({ method: 'notifications/cancelled', params: { requestId: 2, reason: 'stopped' } });
    first.child.stdin!.end();
    expect((await first.exit(EXIT_MS + REPLY_MS)).code).toBe(0);

    const second = startServer(root);
    await second.initialize();
    second.child.stdin!.end();
    await second.exit(EXIT_MS + REPLY_MS);
    expect(second.stderr(), 'the next start found an interrupted index').not.toContain(
      'did not finish',
    );
  }, 60_000);

  // POSIX only: a Windows pipe write is synchronous, and this case has not
  // been run there.
  it.skipIf(process.platform === 'win32')(
    'exits 0, not an EPIPE crash, when the client has gone with a call in flight',
    async () => {
      // A client that dies closes both of its ends: the server's stdin, and
      // the pipe the server writes its replies into. The reply still owed then
      // fails with EPIPE, which unheard was an uncaught error: exit 1 and a
      // stack trace instead of a clean exit.
      const notes: Record<string, string> = {};
      for (let i = 0; i < 40; i++) notes[`notes/n${i}.md`] = `# Note ${i}\n\nGlacier sensor reading ${i}.\n`;
      const server = startServer(await makeVault(notes));
      await server.initialize();
      server.send({
        id: 2,
        method: 'tools/call',
        params: { name: 'lore_index', arguments: { full: true } },
      });
      server.child.stdout!.destroy();
      server.child.stdin!.end();
      const { code, signal } = await server.exit(EXIT_MS + REPLY_MS);

      expect(signal).toBeNull();
      expect(code, `stderr:\n${server.stderr()}`).toBe(0);
    },
    45_000,
  );
});
