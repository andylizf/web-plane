import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';
import { CdpConnection } from '../../lib/cdp-client.js';

const home = makeTmpDir('lane-reclamation');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `q${process.pid}`);
const session = `qp${process.pid}`;
const ttlMs = 60_000;
const intervalMs = 300;
const logDir = join(REPO_ROOT, 'logs', 'lane-reclamation', 'integration');
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

function expireLane(lane) {
  // Finish page setup before advancing its persisted lease past the deadline.
  // A short real-time lease can expire during unrelated CI setup work.
  const key = createHash('sha256').update(lane).digest('hex');
  const path = join(runtime, 'lanes', `${key}.json`);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.lastCommandAt = new Date(Date.now() - ttlMs - 1_000).toISOString();
  const staged = `${path}.expiry`;
  writeFileSync(staged, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  renameSync(staged, path);
}

function agentBrowserPid(lane) {
  try {
    return Number(readFileSync(join(socketDir, `${lane}.pid`), 'utf8').trim());
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function browserPid() {
  const result = cli([`-s=${session}`, 'status']);
  assert.equal(result.code, 0, result.all);
  const pid = Number(result.stdout.match(/Chrome PID:\s+(\d+)/)?.[1]);
  assert.ok(pid > 1, result.all);
  return pid;
}

async function waitForBrowserGone(pid, port) {
  const deadline = Date.now() + 10_000;
  while (processIsAlive(pid) && Date.now() < deadline) await sleep(100);
  if (processIsAlive(pid)) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => null);
    assert.fail(`empty Chrome ${pid} stayed resident: ${JSON.stringify({ targets, events: sessionEvents() })}`);
  }
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
    last = {
      mapping: laneState(lane),
      target: await targetExists(state),
      daemon: processIsAlive(state.daemonPid),
      daemonSidecar: existsSync(join(socketDir, `${lane}.pid`)),
      monitor: processIsAlive(state.monitorPid),
    };
    if (
      last.mapping === null &&
      last.target === false &&
      last.daemon === false &&
      last.daemonSidecar === false && last.monitor === false
    ) return { ok: true, last };
    await sleep(150);
  }
  record('lane-cleanup-timeout', 'failed', { lane, last, events: sessionEvents() });
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
  const daemonPid = agentBrowserPid(lane);
  assert.ok(Number.isInteger(daemonPid) && daemonPid > 1, `missing daemon pid for ${lane}`);
  const key = createHash('sha256').update(lane).digest('hex');
  const monitorPid = JSON.parse(readFileSync(join(runtime, 'run', `.lane-monitor-${key}.json`), 'utf8')).pid;
  return { ...state, daemonPid, monitorPid };
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

test('hard idle timeout closes abandoned lanes regardless of page state', async () => {
  const clean = `cln${process.pid}`;
  const cleanState = attach(clean, '/clean');
  const initialTargets = await fetch(`http://127.0.0.1:${cleanState.port}/json/list`).then(r => r.json());
  assert.deepEqual(initialTargets.filter(target => target.type === 'page').map(target => target.id),
    [cleanState.targetId], 'fresh attach left a startup page outside its lane');
  const sibling = `sib${process.pid}`;
  const siblingState = attach(sibling, '/clean');
  const firstBrowserPid = browserPid();
  expireLane(clean);
  const cleanGone = await waitForLaneGone(clean, cleanState);
  assert.equal(cleanGone.ok, true, `clean lane survived: ${JSON.stringify(cleanGone.last)}`);
  assert.equal(await targetExists(siblingState), true, 'closing one lane closed its sibling tab');
  assert.equal(processIsAlive(siblingState.daemonPid), true, 'closing one lane stopped its sibling driver');
  assert.equal(processIsAlive(firstBrowserPid), true, 'closing one lane quit a shared browser');
  laneCommand(sibling, 'close');
  const siblingGone = await waitForLaneGone(sibling, siblingState);
  assert.equal(siblingGone.ok, true, 'explicit lane close left its driver running');
  await waitForBrowserGone(firstBrowserPid, siblingState.port);
  record('lane-and-driver-hard-timeout', 'passed', { siblingSurvived: true });

  const renewed = `cmd${process.pid}`;
  const renewedState = attach(renewed, '/clean');
  assert.notEqual(browserPid(), firstBrowserPid, 'reattach did not launch a fresh browser');
  const previousCommandAt = laneState(renewed).lastCommandAt;
  laneCommand(renewed, 'snapshot');
  assert.ok(Date.parse(laneState(renewed).lastCommandAt) > Date.parse(previousCommandAt));
  await sleep(1_000);
  assert.ok(laneState(renewed), 'a recent command did not refresh the lease');
  expireLane(renewed);
  const renewedGone = await waitForLaneGone(renewed, renewedState);
  assert.equal(renewedGone.ok, true, 'renewed lane did not close after the refreshed lease expired');
  record('command-renews-lease', 'passed');

  const dirty = `dty${process.pid}`;
  const dirtyState = attach(dirty, '/dirty');
  laneCommand(dirty, 'type', 'input', 'unsubmitted draft');
  laneCommand(dirty, 'click', 'button');
  expireLane(dirty);
  const dirtyGone = await waitForLaneGone(dirty, dirtyState);
  assert.equal(dirtyGone.ok, true, 'unsubmitted input bypassed the hard idle timeout');
  record('unsubmitted-input-hard-timeout', 'passed');

  const media = `med${process.pid}`;
  const mediaState = attach(media, '/media');
  expireLane(media);
  const mediaGone = await waitForLaneGone(media, mediaState);
  assert.equal(mediaGone.ok, true, 'playing media bypassed the hard idle timeout');
  record('playing-media-hard-timeout', 'passed');

  const slow = `net${process.pid}`;
  const slowState = attach(slow, '/slow', '--no-wait');
  expireLane(slow);
  const slowGone = await waitForLaneGone(slow, slowState);
  assert.equal(slowGone.ok, true, 'an active request bypassed the hard idle timeout');
  const released = await fetch(`${origin}/release`);
  assert.equal(released.ok, true);
  record('active-network-hard-timeout', 'passed');

  const guarded = `bun${process.pid}`;
  const guardedState = attach(guarded, '/beforeunload');
  laneCommand(guarded, 'click', 'button');
  expireLane(guarded);
  const guardedGone = await waitForLaneGone(guarded, guardedState);
  const guardedEvents = sessionEvents().filter((event) => event.lane === guarded);
  assert.equal(guardedGone.ok, true, 'beforeunload bypassed the hard idle timeout');
  assert.ok(
    guardedEvents.some((event) =>
      event.type === 'lane-reaped' && event.reason === 'hard-timeout'
    ),
    `hard timeout was not recorded: ${JSON.stringify(guardedEvents)}`
  );
  record('beforeunload-hard-timeout', 'passed');

  const visible = `vis${process.pid}`;
  const visibleState = attach(visible, '/clean');
  const visiblePid = browserPid();
  const shown = cli([`-s=${session}`, 'show']);
  assert.equal(shown.code, 0, shown.all);
  expireLane(visible);
  const visibleGone = await waitForLaneGone(visible, visibleState);
  assert.equal(visibleGone.ok, true, 'visible lane bypassed the hard idle timeout');
  await waitForBrowserGone(visiblePid, visibleState.port);
  record('visible-hard-timeout', 'passed');

  const localState = JSON.parse(readFileSync(
    join(runtime, 'profiles', session, 'Local State'),
    'utf8'
  ));
  assert.equal(localState.performance_tuning.high_efficiency_mode.state, 2);
  assert.equal(localState.performance_tuning.high_efficiency_mode.aggressiveness, 2);
  record('maximum-memory-saver-persisted-after-chrome-exit', 'passed');
});

test('reaping the last lane preserves an unowned page in the same browser', async () => {
  const name = `own${process.pid}`;
  const state = attach(name, '/clean');
  const pid = browserPid();
  const connection = await CdpConnection.connect(state.port);
  try {
    const { targetId } = await connection.send('Target.createTarget', { url: `${origin}/clean` });
    expireLane(name);
    const gone = await waitForLaneGone(name, state);
    assert.equal(gone.ok, true, JSON.stringify(gone.last));
    assert.equal(processIsAlive(pid), true, 'reaping a lane quit an unowned page');
    assert.equal(await targetExists({ port: state.port, targetId }), true);
  } finally {
    connection.close();
    const closed = cli([`-s=${session}`, 'close']);
    assert.equal(closed.code, 0, closed.all);
  }
});

test('a restarted lane driver reconnects to its owned Chrome', async () => {
  const name = `drv${process.pid}`;
  const state = attach(name, '/clean');
  const pid = browserPid();
  const disconnected = cli(['agent-browser', '--session', name, '--cdp', String(state.port), 'close']);
  assert.equal(disconnected.code, 0, disconnected.all);
  assert.equal(processIsAlive(pid), true, 'disconnecting the driver closed shared Chrome');
  laneCommand(name, 'snapshot');
  assert.equal(browserPid(), pid);
  assert.equal(laneState(name).targetId, state.targetId);
  assert.equal(await targetExists(state), true);
  laneCommand(name, 'close');
  assert.equal(await targetExists(state), false);
});
