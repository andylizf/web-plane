import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

const home = makeTmpDir('lane-reclamation');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `q${process.pid}`);
const session = `qp${process.pid}`;
const ttlMs = 2_500;
const intervalMs = 300;
const logDir = join(REPO_ROOT, 'logs', 'issue32', 'integration');
const resultLog = join(logDir, 'run.jsonl');
const runId = `${new Date().toISOString()}-${process.pid}`;
let server;
let origin;

function cli(args, timeout = 70_000) {
  return runCli(args, {
    home,
    timeout,
    env: {
      WEB_PLANE_RUNTIME_DIR: runtime,
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      WEB_PLANE_LANE_TTL_MS: String(ttlMs),
      WEB_PLANE_REAP_INTERVAL_MS: String(intervalMs),
    },
  });
}

function record(step, outcome, details = {}) {
  appendFileSync(resultLog, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    runId,
    step,
    outcome,
    ...details,
  })}\n`, { mode: 0o600 });
  chmodSync(resultLog, 0o600);
}

function laneState(lane) {
  const dir = join(runtime, 'lanes');
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const state = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (state.lane === lane) return state;
    } catch {}
  }
  return null;
}

function sessionEvents() {
  const path = join(runtime, 'logs', 'sessions', session, 'session-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function targetExists({ port, targetId }) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    return targets.some((target) => target.id === targetId);
  } catch {
    return false;
  }
}

async function waitForLaneGone(lane, state, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = { mapping: laneState(lane), target: await targetExists(state) };
    if (last.mapping === null && last.target === false) return { ok: true, last };
    await sleep(150);
  }
  return { ok: false, last };
}

function attach(lane, path, ...extra) {
  const result = cli([
    `-s=${session}`,
    'attach',
    '--as',
    lane,
    `${origin}${path}`,
    ...extra,
  ]);
  assert.equal(result.code, 0, result.all);
  const state = laneState(lane);
  assert.ok(state?.targetId && state.port > 0, `missing state for ${lane}`);
  return state;
}

function laneCommand(lane, ...args) {
  const result = cli(['lane', lane, ...args]);
  assert.equal(result.code, 0, result.all);
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);

  server = spawn(process.execPath, [join(REPO_ROOT, 'tests', 'fixtures', 'lane-reclamation-server.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErrors = '';
  server.stderr.on('data', (chunk) => (serverErrors += chunk));
  const lines = createInterface({ input: server.stdout });
  const firstLine = await Promise.race([
    once(lines, 'line').then(([line]) => line),
    once(server, 'exit').then(([code, signal]) => {
      throw new Error(`fixture server exited ${code ?? signal}: ${serverErrors}`);
    }),
  ]);
  origin = `http://127.0.0.1:${JSON.parse(firstLine).port}`;

  console.log('lane-reclamation: installing an isolated exact-checkout runtime');
  const installed = cli(['install']);
  assert.equal(installed.code, 0, installed.all);
});

after(async () => {
  try { cli([`-s=${session}`, 'close']); } catch {}
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('hidden lane reclamation closes only old lanes proven safe', async () => {
  const sibling = `sib${process.pid}`;
  attach(sibling, '/clean');
  laneCommand(sibling, 'keep');
  const clean = `cln${process.pid}`;
  const cleanState = attach(clean, '/clean');
  const cleanGone = await waitForLaneGone(clean, cleanState);
  assert.equal(cleanGone.ok, true, `clean lane survived: ${JSON.stringify(cleanGone.last)}`);
  assert.ok(laneState(sibling), 'the protected sibling lane was also removed');
  record('clean-hidden-lane', 'passed', { siblingSurvived: true });

  const renewed = `cmd${process.pid}`;
  const renewedState = attach(renewed, '/clean');
  await sleep(ttlMs - 700);
  laneCommand(renewed, 'snapshot');
  await sleep(1_000);
  assert.ok(laneState(renewed), 'a recent command did not refresh the lease');
  const renewedGone = await waitForLaneGone(renewed, renewedState);
  assert.equal(renewedGone.ok, true, 'renewed lane did not close after the refreshed lease expired');
  record('command-renews-lease', 'passed');

  const kept = `kep${process.pid}`;
  const keptState = attach(kept, '/clean');
  laneCommand(kept, 'keep');
  await sleep(ttlMs + intervalMs * 3);
  assert.equal(await targetExists(keptState), true, 'keep did not protect the target');
  laneCommand(kept, 'unkeep');
  const keptGone = await waitForLaneGone(kept, keptState);
  assert.equal(keptGone.ok, true, 'unkeep did not restore automatic reclamation');
  record('keep-unkeep', 'passed');

  const dirty = `dty${process.pid}`;
  const dirtyState = attach(dirty, '/dirty');
  laneCommand(dirty, 'type', 'input', 'unsubmitted draft');
  laneCommand(dirty, 'click', 'button');
  const dirtyProbe = laneCommand(
    dirty,
    'eval',
    'window[Symbol.for("web-plane.lifecycle.v1")]?.dirty === true'
  );
  assert.match(dirtyProbe.stdout, /true/, `cancelled reset cleared tracker: ${dirtyProbe.all}`);
  await sleep(ttlMs + intervalMs * 3);
  const dirtyEvents = sessionEvents().filter((event) => event.lane === dirty);
  assert.equal(
    await targetExists(dirtyState),
    true,
    `typed unsubmitted input was reclaimed after a cancelled reset: ${JSON.stringify(dirtyEvents)}`
  );
  record('unsubmitted-input', 'passed');
  laneCommand(dirty, 'close');

  const media = `med${process.pid}`;
  const mediaState = attach(media, '/media');
  await sleep(ttlMs + intervalMs * 3);
  assert.equal(await targetExists(mediaState), true, 'playing media was reclaimed');
  record('playing-media', 'passed');
  laneCommand(media, 'close');

  const slow = `net${process.pid}`;
  const slowState = attach(slow, '/slow', '--no-wait');
  await sleep(ttlMs + intervalMs * 3);
  assert.equal(await targetExists(slowState), true, 'an active response was reclaimed');
  const released = await fetch(`${origin}/release`);
  assert.equal(released.ok, true);
  const slowGone = await waitForLaneGone(slow, slowState);
  assert.equal(slowGone.ok, true, 'lane did not close after the active response finished');
  record('active-network-request', 'passed');

  const guarded = `bun${process.pid}`;
  const guardedState = attach(guarded, '/beforeunload');
  laneCommand(guarded, 'click', 'button');
  await sleep(ttlMs + intervalMs * 4);
  const guardedEvents = sessionEvents().filter((event) => event.lane === guarded);
  assert.equal(
    await targetExists(guardedState),
    true,
    `beforeunload lane was reclaimed: ${JSON.stringify(guardedEvents)}`
  );
  assert.ok(laneState(guarded), 'beforeunload lane mapping was removed');
  assert.ok(
    guardedEvents.some((event) =>
      event.type === 'lane-reap-skipped' && event.reason === 'beforeunload-registered'
    ),
    `beforeunload protection was not recorded: ${JSON.stringify(guardedEvents)}`
  );
  record('beforeunload-protected', 'passed');

  const visible = `vis${process.pid}`;
  const visibleState = attach(visible, '/clean');
  const shown = cli([`-s=${session}`, 'show']);
  assert.equal(shown.code, 0, shown.all);
  await sleep(ttlMs + intervalMs * 3);
  assert.equal(await targetExists(visibleState), true, 'visible session lane was reclaimed');
  const hidden = cli([`-s=${session}`, 'hide']);
  assert.equal(hidden.code, 0, hidden.all);
  const visibleGone = await waitForLaneGone(visible, visibleState);
  assert.equal(visibleGone.ok, true, 'hidden lane did not resume reclamation');
  record('visible-then-hidden', 'passed');
});
