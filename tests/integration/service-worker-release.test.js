import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

// Chrome never idles out a service worker while DevTools is attached, and every
// lane's agent-browser daemon attaches to every worker. The keeper lane below
// holds that attachment, so only web-plane's explicit stop on lane close can
// end the closed lane's worker.
const home = makeTmpDir('service-worker-release');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `w${process.pid}`);
const session = `sw${process.pid}`;
const stopDeadlineMs = 15_000;
let server;
let port;

function cli(args, timeout = 70_000) {
  return runCli(args, {
    home,
    timeout,
    env: { WEB_PLANE_RUNTIME_DIR: runtime, AGENT_BROWSER_SOCKET_DIR: socketDir },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function laneState(lane) {
  const key = createHash('sha256').update(lane).digest('hex');
  const path = join(runtime, 'lanes', `${key}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function attach(lane, url) {
  const result = cli([`-s=${session}`, 'attach', '--as', lane, url]);
  assert.equal(result.code, 0, result.all);
  const state = laneState(lane);
  assert.ok(state?.port > 0, `missing state for ${lane}`);
  return state;
}

async function workers(cdpPort) {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
  return targets.filter((t) => t.type === 'service_worker' && t.url.includes(`127.0.0.1:${port}/sw.js`));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(500);
  }
  return false;
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  server = spawn(process.execPath, [join(REPO_ROOT, 'tests', 'fixtures', 'service-worker-server.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [line] = await once(createInterface({ input: server.stdout }), 'line');
  port = JSON.parse(line).port;
  console.log('service-worker-release: installing an isolated exact-checkout runtime');
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

test("a site's service worker stops once the lane that opened it closes", async () => {
  // The keeper is another origin, outside the worker's scope, so it keeps
  // Chrome running without giving the worker a client.
  const keeper = `kp${process.pid}`;
  const keeperState = attach(keeper, `http://localhost:${port}/plain`);
  const lane = `reg${process.pid}`;
  const state = attach(lane, `http://127.0.0.1:${port}/register`);
  assert.equal(state.port, keeperState.port, 'the lanes did not share one browser');

  assert.ok(await waitFor(async () => (await workers(state.port)).length > 0, 15_000),
    'the fixture page never started its service worker');

  const closed = cli(['lane', lane, 'close']);
  assert.equal(closed.code, 0, closed.all);

  const stopped = await waitFor(async () => (await workers(state.port)).length === 0, stopDeadlineMs);
  assert.ok(stopped,
    `service worker still running ${stopDeadlineMs / 1000}s after its lane closed: ` +
    JSON.stringify(await workers(state.port)));
  cli(['lane', keeper, 'close']);
});
