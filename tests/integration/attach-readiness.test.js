import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CLI } from '../helpers/cli.js';
import { isAlive, requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

const execute = promisify(execFile);
const home = makeTmpDir('attach-readiness');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `ar${process.pid}`);
const session = `ar${process.pid}`;
const lane = `al${process.pid}`;
let server;
let url;

async function cli(args) {
  const options = {
    env: { ...process.env, HOME: home, WEB_PLANE_RUNTIME_DIR: runtime,
      AGENT_BROWSER_SOCKET_DIR: socketDir },
    timeout: 120_000,
  };
  try {
    return { code: 0, ...await execute(process.execPath, [CLI, ...args], options) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function state(name = lane) {
  const key = createHash('sha256').update(name).digest('hex');
  return JSON.parse(readFileSync(join(runtime, 'lanes', `${key}.json`), 'utf8'));
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  server = createServer((req, res) => {
    if (req.url === '/poll') {
      res.end('update');
      return;
    }
    res.end('<!doctype html><title>Attach readiness</title><main>READY</main>' +
      '<script>setInterval(() => fetch("/poll"), 100)</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  const installed = await cli(['install']);
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
});

after(async () => {
  await cli([`-s=${session}`, 'close']);
  server?.closeAllConnections();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('attach accepts a loaded page with continuous network requests', async () => {
  const result = await cli([`-s=${session}`, 'attach', '--as', lane, url, '--timeout', '1500']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const snapshot = await cli(['lane', lane, 'snapshot']);
  assert.equal(snapshot.code, 0, snapshot.stderr);
  assert.match(snapshot.stdout, /READY/);
  const idle = await cli([`-s=${session}`, 'attach', '--as', lane, url,
    '--wait-for', 'networkidle', '--timeout', '1500']);
  assert.notEqual(idle.code, 0, 'fixture must not reach network idle');
});

test('explicit wait failure preserves the tab, driver, and monitor for retry or close', async () => {
  const failedLane = `${lane}f`;
  const args = [`-s=${session}`, 'attach', '--as', failedLane, url];
  const failed = await cli([...args, '--wait-for', '#missing', '--timeout', '500']);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /--wait-for.*--timeout.*--no-wait/s);
  const original = state(failedLane);
  const key = createHash('sha256').update(failedLane).digest('hex');
  const monitor = JSON.parse(readFileSync(join(runtime, 'run', `.lane-monitor-${key}.json`), 'utf8'));
  assert.equal(isAlive(monitor.pid), true, 'readiness failure stopped the lane monitor');
  const daemonPid = Number(readFileSync(join(socketDir, `${failedLane}.pid`), 'utf8'));
  assert.equal(isAlive(daemonPid), true, 'readiness failure stopped the lane driver');
  const snapshot = await cli(['lane', failedLane, 'snapshot']);
  assert.equal(snapshot.code, 0, snapshot.stderr);
  assert.match(snapshot.stdout, /READY/);
  const retried = await cli([...args, '--no-wait']);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(state(failedLane).targetId, original.targetId);
  const closed = await cli(['lane', failedLane, 'close']);
  assert.equal(closed.code, 0, closed.stderr);
  const targets = await fetch(`http://127.0.0.1:${original.port}/json/list`).then(r => r.json());
  assert.equal(targets.some(target => target.id === original.targetId), false);
});

test('a navigation failure leaves its created tab reachable for close', async () => {
  const failedLane = `${lane}n`;
  const failed = await cli([`-s=${session}`, 'attach', '--as', failedLane,
    'http://127.0.0.1:1/', '--no-wait']);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /Failed to navigate/);
  const original = state(failedLane);
  const closed = await cli(['lane', failedLane, 'close']);
  assert.equal(closed.code, 0, closed.stderr);
  const targets = await fetch(`http://127.0.0.1:${original.port}/json/list`).then(r => r.json());
  assert.equal(targets.some(target => target.id === original.targetId), false);
});

test('an attach readiness wait does not hold the sibling profile lock', async () => {
  const waitingLane = `${lane}w`;
  let finished = false;
  const waiting = cli([`-s=${session}`, 'attach', '--as', waitingLane, url,
    '--wait-for', '#missing', '--timeout', '12000']).then(result => {
    finished = true;
    return result;
  });
  const deadline = Date.now() + 30_000;
  let attached = false;
  while (Date.now() < deadline && !finished) {
    try { attached = Boolean(state(waitingLane).targetId); } catch {}
    if (attached) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(attached, true, 'waiting lane was not registered before its readiness wait');
  const sibling = await cli(['lane', lane, 'snapshot']);
  assert.equal(sibling.code, 0, sibling.stderr);
  assert.equal(finished, false, 'sibling command was blocked until attach finished waiting');
  assert.notEqual((await waiting).code, 0);
});
