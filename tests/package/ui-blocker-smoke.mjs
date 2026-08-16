import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const repo = resolve(new URL('../..', import.meta.url).pathname);
const cliPath = resolve(process.env.WEB_PLANE_BIN ?? resolve(repo, 'bin/web-plane.js'));
const runtimeDir = process.env.WEB_PLANE_RUNTIME_DIR;
const logPath = resolve(
  process.env.WEB_PLANE_TEST_LOG ?? resolve(repo, 'tmp/ui-blocker-smoke/logs/run.jsonl')
);
// playwright-cli puts the session name in a Unix-domain socket path. macOS
// rejects long socket paths with EINVAL, and its temporary-directory prefix is
// already long, so keep the test identifier intentionally short.
const session = `uib-${process.pid}`;
const lane = session;
const otherLane = `uio-${process.pid}`;
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

assert.ok(runtimeDir, 'WEB_PLANE_RUNTIME_DIR must name an isolated installed runtime');
mkdirSync(dirname(logPath), { recursive: true });

function record(step, outcome, details = {}) {
  const entry = { timestamp: new Date().toISOString(), step, outcome, ...details };
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

async function cli(args, { expect = null } = {}) {
  const result = await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEB_PLANE_RUNTIME_DIR: runtimeDir },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ status: null, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        status,
        stdout,
        stderr: signal ? `${stderr}terminated by ${signal}\n` : stderr,
      });
    });
  });
  const observed = {
    command: ['web-plane', ...args],
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  record(args.join(' '), result.status === 0 ? 'success' : 'nonzero', observed);
  if (expect !== null) assert.equal(result.status, expect, JSON.stringify(observed));
  return observed;
}

function frontmostPid() {
  const result = spawnSync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

function cleanupAgentBrowser(targetLane) {
  const stateDir = resolve(homedir(), '.agent-browser');
  const pidFile = resolve(stateDir, `${targetLane}.pid`);
  if (!existsSync(pidFile)) return;
  const closed = spawnSync(
    'agent-browser',
    ['--session', targetLane, 'close'],
    { encoding: 'utf8' }
  );
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (const suffix of ['pid', 'config', 'version', 'stream', 'sock', 'target']) {
    rmSync(resolve(stateDir, `${targetLane}.${suffix}`), { force: true });
  }
  record('agent-browser-cleanup', closed.status === 0 ? 'success' : 'nonzero', {
    lane: targetLane,
    exitCode: closed.status,
    stdout: closed.stdout ?? '',
    stderr: closed.stderr ?? '',
    pid,
  });
}

function cleanupPlaywrightSidecars() {
  const daemonRoot = resolve(homedir(), 'Library/Caches/ms-playwright/daemon');
  if (!existsSync(daemonRoot)) return;
  const removed = [];
  for (const namespace of readdirSync(daemonRoot)) {
    for (const suffix of ['session', 'err']) {
      const path = resolve(daemonRoot, namespace, `${session}.${suffix}`);
      if (!existsSync(path)) continue;
      rmSync(path, { force: true });
      removed.push(path);
    }
  }
  record('playwright-sidecar-cleanup', 'success', { removed });
}

function refFor(snapshot, label) {
  const line = snapshot.split('\n').find((candidate) => candidate.includes(`"${label}"`));
  const ref = line?.match(/ref=(e\d+)/)?.[1];
  assert.ok(ref, `snapshot has no ref for ${label}:\n${snapshot}`);
  return ref;
}

async function waitForLaneLock() {
  const runDir = resolve(runtimeDir, 'run');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      existsSync(runDir) &&
      readdirSync(runDir).some((name) => name.startsWith('.profile-command-'))
    ) return;
    await sleep(10);
  }
  assert.fail('holding lane never acquired the profile command lock');
}

function profileLockPath() {
  const key = createHash('sha256').update(session).digest('hex');
  return resolve(runtimeDir, 'run', `.profile-command-${key}.lock`);
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>web-plane UI blocker smoke</title>
<button id="trigger">Trigger WebAuthn</button>
<button id="other">Other action</button>
<output id="log">idle</output>
<script>
  const log = document.querySelector('#log');
  document.querySelector('#trigger').addEventListener('click', () => {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    navigator.credentials.get({ publicKey: {
      challenge,
      timeout: 600000,
      userVerification: 'discouraged',
      allowCredentials: [{
        type: 'public-key',
        id: new Uint8Array([1, 3, 3, 7, 9, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]),
        transports: ['usb'],
      }],
    }}).then(() => { log.textContent = 'credential-returned'; })
      .catch((error) => { log.textContent = 'credential-' + error.name; });
  });
  document.querySelector('#other').addEventListener('click', () => {
    log.textContent = 'other-clicked';
  });
</script>`;

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(request.url === '/clear' ? '<title>clear</title><p>clear</p>' : html);
});

await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
const origin = `http://localhost:${port}`;
record('server', 'success', { origin, html });

try {
  await cli(['doctor'], { expect: 0 });
  const beforeAttachFocus = frontmostPid();
  await cli([`-s=${session}`, 'attach', '--as', lane, origin], { expect: 0 });
  await cli([`-s=${session}`, 'attach', '--as', otherLane, origin], { expect: 0 });
  const afterAttachFocus = frontmostPid();
  assert.equal(
    afterAttachFocus,
    beforeAttachFocus,
    `hidden attach changed focus ${beforeAttachFocus} -> ${afterAttachFocus}`
  );
  record('focus-after-attach', 'success', { beforeAttachFocus, afterAttachFocus });

  const staleLock = profileLockPath();
  writeFileSync(
    staleLock,
    JSON.stringify({ token: 'dead-test-owner', pid: 2147483647, session, createdAt: 0 }),
    { mode: 0o600 }
  );
  const staleTime = new Date(Date.now() - 2_000);
  utimesSync(staleLock, staleTime, staleTime);
  await cli(['lane', lane, 'eval', '1'], { expect: 0 });
  assert.equal(existsSync(staleLock), false, 'dead owner left the profile permanently locked');
  record('stale-profile-lock-recovery', 'success');

  // Chrome has only one selected tab. The target activation and UI gates must
  // therefore be serialized across lanes that share a profile, even though
  // agent-browser keeps their pinned target state independently.
  const holdingLane = cli(['lane', lane, 'wait', '800'], { expect: 0 });
  await waitForLaneLock();
  const queuedAt = Date.now();
  await cli(['lane', otherLane, 'eval', '1'], { expect: 0 });
  const queuedMs = Date.now() - queuedAt;
  await holdingLane;
  assert.ok(queuedMs >= 500, `second lane bypassed the profile lock after ${queuedMs}ms`);
  record('lane-command-serialization', 'success', { queuedMs });

  const holdingForAttach = cli(['lane', lane, 'wait', '800'], { expect: 0 });
  await waitForLaneLock();
  const attachQueuedAt = Date.now();
  await cli([`-s=${session}`, 'attach', '--as', otherLane, origin], { expect: 0 });
  const attachQueuedMs = Date.now() - attachQueuedAt;
  await holdingForAttach;
  assert.ok(
    attachQueuedMs >= 500,
    `attach bypassed the profile lock after ${attachQueuedMs}ms`
  );
  record('attach-serialization', 'success', { attachQueuedMs });

  // Keep a ref from lane A, then make lane B create and select another target.
  // agent-browser 0.33 moved A's pointer too; web-plane had to switch it back,
  // and that switch destroyed A's ref table. Native 0.34 pinning must preserve
  // both the target and the ref without a pre-command tab operation.
  const pinSnapshot = await cli(['lane', lane, 'snapshot'], { expect: 0 });
  const pinnedOtherRef = refFor(pinSnapshot.stdout, 'Other action');
  await cli(
    ['lane', otherLane, 'tab', 'new', '--label', `${otherLane}-extra`, origin],
    { expect: 0 }
  );
  await cli(['lane', lane, 'click', pinnedOtherRef], { expect: 0 });
  const pinnedResult = await cli(
    ['lane', lane, 'eval', "document.querySelector('#log').textContent"],
    { expect: 0 }
  );
  assert.match(pinnedResult.stdout, /other-clicked/);
  record('native-tab-pinning', 'success', {
    lane,
    competingLane: otherLane,
    preservedRef: pinnedOtherRef,
  });
  await cli(['lane', lane, 'goto', origin], { expect: 0 });

  const beforeFocus = frontmostPid();
  const snapshot = await cli(['lane', lane, 'snapshot'], { expect: 0 });
  const triggerRef = refFor(snapshot.stdout, 'Trigger WebAuthn');

  const trigger = await cli(['lane', lane, 'click', triggerRef], { expect: 3 });
  assert.match(trigger.stderr, /UI_BLOCKED_AFTER_COMMAND/);
  assert.match(trigger.stderr, /"commandExecuted":true/);

  const status = await cli([`-s=${session}`, 'ui', 'status'], { expect: 0 });
  const ui = JSON.parse(status.stdout);
  assert.equal(ui.blockers.length, 1, status.stdout);
  assert.equal(ui.blockers[0].kind, 'browser-modal');
  assert.equal(ui.blockers[0].ownerLane, lane);
  assert.deepEqual(ui.blockers[0].actions, ['wait', 'show', 'abort-by-navigation']);
  assert.equal(ui.blockers[0].showCommand, `web-plane -s=${session} show`);

  const afterFocus = frontmostPid();
  assert.equal(afterFocus, beforeFocus, `hidden blocker changed focus ${beforeFocus} -> ${afterFocus}`);
  record('focus-after-blocker', 'success', { beforeFocus, afterFocus });

  // The Chromium surface is tab-modal, not browser-modal. Driving another lane
  // must hide the first tab's child window and leave the second tab usable.
  const otherSnapshot = await cli(['lane', otherLane, 'snapshot'], { expect: 0 });
  assert.doesNotMatch(otherSnapshot.stderr, /UI_BLOCKED/);
  const otherRef = refFor(otherSnapshot.stdout, 'Other action');
  await cli(['lane', otherLane, 'click', otherRef], { expect: 0 });
  const otherResult = await cli(
    ['lane', otherLane, 'eval', "document.querySelector('#log').textContent"],
    { expect: 0 }
  );
  assert.match(otherResult.stdout, /other-clicked/);

  // Driving the blocked lane makes its child modal current again, so the
  // gate must refuse input before it reaches agent-browser.
  const blocked = await cli(['lane', lane, 'click', triggerRef], { expect: 3 });
  assert.match(blocked.stderr, /"code":"UI_BLOCKED"/);
  assert.match(blocked.stderr, /"commandExecuted":false/);

  const idle = await cli(['lane', lane, 'eval', "document.querySelector('#log').textContent"], {
    expect: 0,
  });
  assert.match(idle.stdout, /idle/);
  assert.match(idle.stderr, /UI_BLOCKED/);

  await cli(['lane', lane, 'goto', `${origin}/clear`], { expect: 0 });
  const cleared = JSON.parse((await cli([`-s=${session}`, 'ui', 'status'], { expect: 0 })).stdout);
  assert.deepEqual(cleared.blockers, []);

  await cli(['lane', lane, 'goto', origin], { expect: 0 });
  const resumedSnapshot = await cli(['lane', lane, 'snapshot'], { expect: 0 });
  const resumedOtherRef = refFor(resumedSnapshot.stdout, 'Other action');
  await cli(['lane', lane, 'click', resumedOtherRef], { expect: 0 });
  const resumed = await cli(['lane', lane, 'eval', "document.querySelector('#log').textContent"], {
    expect: 0,
  });
  assert.match(resumed.stdout, /other-clicked/);
  record('smoke', 'success', { logPath });
} catch (error) {
  record('smoke', 'failure', { message: error.message, stack: error.stack });
  throw error;
} finally {
  await cli([`-s=${session}`, 'close']);
  cleanupAgentBrowser(lane);
  cleanupAgentBrowser(otherLane);
  cleanupPlaywrightSidecars();
  await new Promise((resolveClose) => server.close(resolveClose));
}
