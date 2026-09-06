import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  agentBrowserSidecarPaths,
  normalizeSpawnTimeout,
  stopAgentBrowserDaemon,
} from '../../lib/agent-browser.js';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

test('a bounded subprocess timeout becomes a named non-zero result', () => {
  const result = normalizeSpawnTimeout(
    { status: null, stderr: '', error: { code: 'ETIMEDOUT' } },
    { phase: 'Playwright hidden launch', timeoutMs: 45_000 }
  );
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /Playwright hidden launch timed out after 45000ms/);
});

test('ordinary subprocess results are preserved', () => {
  const result = { status: 0, stderr: '' };
  assert.equal(normalizeSpawnTimeout(result, { phase: 'connect', timeoutMs: 1 }), result);
});

test('daemon sidecars cannot escape their runtime directory', () => {
  assert.equal(agentBrowserSidecarPaths('../other-session'), null);
  assert.equal(agentBrowserSidecarPaths('nested/other-session'), null);
  assert.equal(agentBrowserSidecarPaths('lane with spaces'), null);
  assert.equal(agentBrowserSidecarPaths('lane\nnewline'), null);
  const paths = agentBrowserSidecarPaths('safe_lane-1');
  assert.match(paths.pid, /safe_lane-1\.pid$/);
  assert.match(paths.sock, /safe_lane-1\.sock$/);
});

// stopAgentBrowserDaemon had no coverage before the monitor started calling it
// on a dropped browser connection. What matters there is that it reaps a lane's
// own dead daemon and refuses to touch anything else.

const daemonDir = makeTmpDir('agent-browser-daemon');
process.env.AGENT_BROWSER_SOCKET_DIR = daemonDir;
test.after(() => removeTmpDir(daemonDir));

const writeSidecars = (lane, pid) => {
  const paths = agentBrowserSidecarPaths(lane);
  for (const [suffix, path] of Object.entries(paths)) {
    writeFileSync(path, suffix === 'pid' && pid != null ? `${pid}\n` : 'x');
  }
  return paths;
};

test('a lane with no pid file is already stopped, and its sidecars go', async () => {
  const paths = writeSidecars('no-pid-lane', null);
  unlinkSync(paths.pid);
  const result = await stopAgentBrowserDaemon('no-pid-lane');
  assert.equal(result.stopped, true);
  assert.equal(result.reason, 'not-running');
  assert.equal(existsSync(paths.sock), false);
  assert.equal(existsSync(paths.config), false);
});

test('a pid whose process is gone is reaped and its sidecars go', async () => {
  const dead = spawnSync('/usr/bin/true').pid;
  const paths = writeSidecars('dead-pid-lane', dead);
  const result = await stopAgentBrowserDaemon('dead-pid-lane');
  assert.equal(result.stopped, true);
  assert.equal(result.reason, 'not-running');
  assert.equal(result.pid, dead);
  assert.equal(existsSync(paths.pid), false);
  assert.equal(existsSync(paths.stream), false);
});

test('a live pid that is not our packaged binary is left completely alone', async () => {
  // This process is alive and is definitely not node_modules/agent-browser/bin,
  // so the owner check must refuse it -- signalling it would kill the test run.
  const paths = writeSidecars('foreign-pid-lane', process.pid);
  const result = await stopAgentBrowserDaemon('foreign-pid-lane');
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'pid-owner-mismatch');
  assert.equal(result.pid, process.pid);
  // Sidecars stay: they belong to whatever really owns that pid.
  assert.equal(existsSync(paths.pid), true);
  assert.equal(existsSync(paths.sock), true);
});

test('an unsafe lane name reaps nothing', async () => {
  const result = await stopAgentBrowserDaemon('../escape');
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'unsafe-session-name');
});
