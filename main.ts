// Process lifecycle for the forge.
//
// The forge is a long-lived server, and the suite that drives it lives at MAKEFUN_ENV_URL:
//   1. bind an ephemeral port (never 8080, which belongs to the suite),
//   2. tell the suite which port was bound (POST /register),
//   3. keep serving while polling GET /done,
//   4. exit 0 as soon as the suite says it is finished.
// Without MAKEFUN_ENV_URL the forge still starts and simply serves until it is killed, which is
// what a person running it by hand wants (FORGE_PORT picks the port in that mode).

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const standalone = envUrl === '';

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Backoff between attempts: 200 ms doubling up to 1.6 s. */
function backoff(attempt: number): number {
  return Math.min(1600, 200 * 2 ** Math.min(attempt, 3));
}

function say(line: string): void {
  process.stdout.write(`[forge] ${line}\n`);
}

/** Announce the bound port until the suite takes it (200) or says someone already did (409). */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal = '';
    try {
      const reply = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(20_000),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) fatal = `register was refused with HTTP ${reply.status}`;
    } catch {
      // the suite may not be listening yet; try again
    }
    if (fatal !== '') throw new Error(fatal);
    await pause(backoff(attempt));
  }
}

/** Poll until the suite reports {"done": true}. A failed poll only means "not yet". */
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(20_000) });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // keep polling
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const wanted = standalone ? Number(process.env.FORGE_PORT ?? 0) || 0 : 0;
  await new Promise<void>((ready, failed) => {
    server.once('error', failed);
    server.listen(wanted, () => ready());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port was bound');
  say(`listening on port ${address.port}`);
  if (standalone) {
    say('MAKEFUN_ENV_URL is not set: serving until stopped');
    await new Promise<void>(() => undefined);
    return;
  }
  await announce(address.port);
  say('registered with the suite');
  await untilDone();
  say('the suite is done');
  server.close();
  server.closeAllConnections();
}

// A stray rejection in one request must never take the whole forge down.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[forge] uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[forge] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
