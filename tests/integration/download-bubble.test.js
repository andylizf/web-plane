import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { CdpConnection } from '../../lib/cdp-client.js';
import {
  buildRuntime,
  finishLaunchTransition,
  isAlive,
  killQuietly,
  launchClone,
  requireMacGui,
} from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

const home = makeTmpDir('download-bubble');
const socketDir = join(REPO_ROOT, 'tmp', `db-${process.pid}`);
process.env.WEB_PLANE_RUNTIME_DIR = join(home, '.web-plane');
const { RUNTIME_VERSION } = await import('../../lib/config.js');
const { prepareManagedProfile } = await import('../../lib/profile-runtime.js');
const { sendPanelRequest } = await import('../../lib/panel.js');
let lane;
let driverConnected = false;
const content = 'web-plane download-bubble integration fixture\n';
const logPath = join(REPO_ROOT, 'logs', `download-bubble-${process.pid}.jsonl`);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let runtime;
let chrome;
let server;
let origin;

function record(step, details = {}) {
  appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), step, ...details })}\n`);
}

async function cli(args) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'bin/web-plane.js'), ...args], {
      env: {
        ...process.env,
        HOME: home,
        WEB_PLANE_RUNTIME_DIR: runtime.runtime,
        AGENT_BROWSER_SOCKET_DIR: socketDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, all: stdout + stderr });
    });
  });
  record('cli', { args, ...result });
  return result;
}

async function uiStatus(session) {
  const result = await cli([`-s=${session}`, 'ui', 'status']);
  assert.equal(result.code, 0, result.all);
  return JSON.parse(result.stdout);
}

async function nativeStatus() {
  const status = await sendPanelRequest(
    { pid: chrome.pid, runId: chrome.runId, managed: true },
    { action: 'ui-status' },
    { runDir: runtime.runDir }
  );
  assert.equal(status.ok, true, JSON.stringify(status));
  return status;
}

function preferences(session) {
  const profile = join(runtime.profilesDir, session);
  const downloads = join(home, `downloads-${session}`);
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  const path = join(profile, 'Default', 'Preferences');
  writeFileSync(path, JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
    download_bubble: { partial_view_enabled: true, partial_view_impressions: 7 },
    unrelated: { preserved: 'download-bubble-test' },
  }));
  return { profile, downloads, path, downloaded: join(downloads, 'fixture.txt') };
}

async function start(session) {
  chrome = await launchClone({ paths: runtime, session });
  await finishLaunchTransition(chrome);
  record('browser-start', { session, pid: chrome.pid, version: chrome.version.Browser });
}

async function closeBrowser() {
  if (!chrome) return;
  if (driverConnected) {
    await cli(['agent-browser', '--session', lane, 'close']);
    driverConnected = false;
  }
  if (isAlive(chrome.pid)) {
    const cdp = await CdpConnection.connect(chrome.port);
    try { await cdp.send('Browser.close'); } catch (error) {
      assert.match(error.message, /CDP connection closed/);
    } finally { cdp.close(); }
    for (let attempt = 0; attempt < 30 && isAlive(chrome.pid); attempt++) await sleep(100);
  }
  killQuietly(chrome.pid);
  record('browser-closed', { pid: chrome.pid, alive: isAlive(chrome.pid) });
  assert.equal(isAlive(chrome.pid), false);
  chrome = null;
}

async function bindLane(session) {
  const connected = await cli(['agent-browser', '--session', lane, '--no-pin-tab', 'connect', String(chrome.port)]);
  assert.equal(connected.code, 0, connected.all);
  driverConnected = true;
  const opened = await cli([
    'agent-browser', '--session', lane, '--cdp', String(chrome.port), '--pin-tab',
    'tab', 'new', '--label', lane, origin,
  ]);
  assert.equal(opened.code, 0, opened.all);
  mkdirSync(join(runtime.runtime, 'lanes'), { recursive: true });
  writeFileSync(join(runtime.runtime, 'lanes', `${lane}.json`), JSON.stringify({ session, port: chrome.port }));
}

before(async () => {
  requireMacGui();
  mkdirSync(join(REPO_ROOT, 'logs'), { recursive: true });
  mkdirSync(socketDir, { recursive: true });
  record('start', { home, socketDir });
  runtime = buildRuntime(home);
  runtime.runDir = join(runtime.runtime, 'run');
  mkdirSync(runtime.runDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runtime.runtime, 'runtime-version'), `${RUNTIME_VERSION}\n`);
  server = createServer((request, response) => {
    if (request.url === '/download') {
      response.setHeader('Content-Type', 'text/plain');
      response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
      response.end(content);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>Download bubble regression</title>
      <button id="download">Download fixture</button>
      <button id="other">Other action</button>
      <label>Message <input id="message" aria-label="Message"></label>
      <button id="auth">Trigger WebAuthn</button><output id="out">idle</output>
      <script>
        download.onclick = () => { const a = document.createElement('a'); a.href = '/download'; a.download = 'fixture.txt'; a.click(); };
        other.onclick = () => out.textContent = 'other-clicked';
        auth.onclick = () => navigator.credentials.get({ publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)), timeout: 600000,
          userVerification: 'discouraged', allowCredentials: [{
            type: 'public-key', id: new Uint8Array([1, 3, 3, 7, 9, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]),
            transports: ['usb'],
          }],
        }}).catch(error => out.textContent = error.name);
      </script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${server.address().port}`;
});

after(async () => {
  try { await closeBrowser(); } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    removeTmpDir(socketDir);
    removeTmpDir(home);
  }
});

test('a parented download bubble permits lane click and type while WebAuthn still blocks', async () => {
  // Chrome auto-closes the partial bubble after five seconds; isolate each input.
  for (const operation of ['click', 'type']) {
    lane = operation === 'click' ? 'dbc' : 'dbt';
    const session = `download-enabled-${operation}`;
    const profile = preferences(session);
    try {
      await start(session);
      await bindLane(session);
      const trigger = await cli(['lane', lane, 'click', '#download']);
      assert.equal(trigger.code, 0, trigger.all);
      let status;
      for (let attempt = 0; attempt < 30; attempt++) {
        status = await uiStatus(session);
        if (status.surfaces.length && existsSync(profile.downloaded)) break;
        await sleep(100);
      }
      assert.equal(readFileSync(profile.downloaded, 'utf8'), content);
      assert.deepEqual(status.blockers, []);
      assert.equal(status.surfaces.length, 1, JSON.stringify(status));
      const surface = status.surfaces[0];
      assert.equal(surface.kind, 'browser-surface');
      assert.equal(surface.scope, 'window');
      assert.equal(surface.class, 'NativeWidgetMacNSWindow');
      assert.equal(surface.blocking, false);
      assert.deepEqual(surface.actions, ['wait', 'show']);
      record('download-surface', { operation, status });

      const input = await cli(operation === 'click'
        ? ['lane', lane, 'click', '#other']
        : ['lane', lane, 'type', '#message', 'bubble input succeeds']);
      assert.equal(input.code, 0, input.all);
      const afterInput = await nativeStatus();
      assert.ok(afterInput.surfaces.some((candidate) => candidate.id === surface.id), JSON.stringify(afterInput));
      assert.deepEqual(afterInput.blockers, []);
      record('surface-after-input', { operation, status: afterInput });
      if (operation === 'type') assert.match(input.stderr, /verified field value "bubble input succeeds"/);
      const readback = await cli(['lane', lane, 'eval', '({ clicked: out.textContent, message: document.querySelector("input").value })']);
      assert.equal(readback.code, 0, readback.all);
      assert.deepEqual(JSON.parse(readback.stdout), {
        clicked: operation === 'click' ? 'other-clicked' : 'idle',
        message: operation === 'type' ? 'bubble input succeeds' : '',
      });

      if (operation === 'type') {
        const auth = await cli(['lane', lane, 'click', '#auth']);
        assert.equal(auth.code, 3, auth.all);
        assert.match(auth.stderr, /UI_BLOCKED_AFTER_COMMAND/);
        const withModal = await uiStatus(session);
        assert.equal(withModal.blockers.length, 1, JSON.stringify(withModal));
        assert.equal(withModal.blockers[0].kind, 'browser-modal');
        assert.equal(withModal.blockers[0].blocking, true);
        const blocked = await cli(['lane', lane, 'click', '#other']);
        assert.equal(blocked.code, 3, blocked.all);
        assert.match(blocked.stderr, /"commandExecuted":false/);
        record('webauthn-blocker', { status: withModal });

        const clear = await cli(['lane', lane, 'goto', `${origin}/clear`, '--wait-for', 'load']);
        assert.equal(clear.code, 0, clear.all);
        const cleared = await uiStatus(session);
        assert.deepEqual(cleared.blockers, []);
        const resumed = await cli(['lane', lane, 'click', '#other']);
        assert.equal(resumed.code, 0, resumed.all);
      }
    } finally { await closeBrowser(); }
  }
});

test('managed profile preparation suppresses automatic download UI without changing download behavior', async () => {
  const session = 'download-disabled';
  const profile = preferences(session);
  const prepared = prepareManagedProfile(session);
  const prefs = JSON.parse(readFileSync(profile.path, 'utf8'));
  assert.equal(prefs.download_bubble.partial_view_enabled, false);
  assert.equal(prefs.download_bubble.partial_view_impressions, 7);
  assert.deepEqual(prefs.unrelated, { preserved: 'download-bubble-test' });
  assert.equal(JSON.parse(readFileSync(prepared.backup, 'utf8')).download_bubble.partial_view_enabled, true);
  record('prepared-preferences', { download_bubble: prefs.download_bubble, unrelated: prefs.unrelated });
  try {
    await start(session);
    const cdp = await CdpConnection.connect(chrome.port);
    try {
      const targets = await cdp.send('Target.getTargets');
      const targetId = targets.targetInfos.find((target) => target.type === 'page').targetId;
      const page = await cdp.attachTarget(targetId);
      await cdp.send('Page.navigate', { url: origin }, page);
      for (let attempt = 0; attempt < 30; attempt++) {
        const ready = await cdp.send('Runtime.evaluate', { expression: '!!document.querySelector("#download")' }, page);
        if (ready.result.value) break;
        await sleep(100);
      }
      await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#download").click()', userGesture: true }, page);
      const deadline = Date.now() + 5000;
      let samples = 0;
      while (Date.now() < deadline) {
        const status = await nativeStatus();
        assert.deepEqual(status.blockers, [], JSON.stringify(status));
        assert.deepEqual(status.surfaces, [], JSON.stringify(status));
        samples++;
        await sleep(100);
      }
      assert.equal(readFileSync(profile.downloaded, 'utf8'), content);
      record('disabled-download', { samples, contents: content, blockers: [], surfaces: [] });
    } finally { cdp.close(); }
  } finally { await closeBrowser(); }
});
