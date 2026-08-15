import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sendPanelRequest } from '../../lib/panel.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

let dir;
let dylib;
let host;
let runDir;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(() => {
  dir = makeTmpDir('panel-control');
  dylib = join(dir, 'window_suppress.dylib');
  host = join(dir, 'panel_control_host');
  runDir = join(dir, 'run');
  mkdirSync(runDir, { mode: 0o700 });
  execFileSync('cc', [
    '-Wall',
    '-Werror',
    '-dynamiclib',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    dylib,
    join(REPO_ROOT, 'native', 'window_suppress.m'),
    join(REPO_ROOT, 'native', 'panel_control.m'),
  ]);
  execFileSync('cc', [
    '-Wall',
    '-Werror',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    host,
    join(REPO_ROOT, 'tests', 'native', 'panel_control_host.m'),
  ]);
  execFileSync('codesign', ['--force', '--sign', '-', host], { stdio: 'ignore' });
});

after(() => dir && removeTmpDir(dir));

function linesFrom(stream) {
  let buffered = '';
  const waiting = [];
  const drain = () => {
    while (buffered.includes('\n') && waiting.length) {
      const at = buffered.indexOf('\n');
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      waiting.shift().resolve(JSON.parse(line));
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    drain();
  });
  return () =>
    new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      stream.once('error', reject);
      drain();
    });
}

async function launchPanel(kind, initialDirectory, { visible = false } = {}) {
  const runId = randomUUID();
  const proc = spawn(host, [kind, initialDirectory], {
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: dylib,
      WEB_PLANE_RUN_ID: runId,
      WEB_PLANE_RUN_DIR: runDir,
      ...(visible ? { WEB_PLANE_START_VISIBLE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const nextLine = linesFrom(proc.stdout);
  const ready = await nextLine();
  assert.equal(ready.event, 'ready', stderr);
  return {
    proc,
    nextLine,
    stderr: () => stderr,
    chrome: { pid: proc.pid, runId, managed: true },
    automationFlag: join(runDir, `.panel-automation-${runId}`),
    hiddenFlag: join(runDir, `.chrome-hidden-${runId}`),
  };
}

async function status(running) {
  const response = await sendPanelRequest(running.chrome, { action: 'status' }, { runDir });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.panel, JSON.stringify(response));
  return response.panel;
}

test('native Save panel reports state and accepts one exact non-existing path', async () => {
  const target = join(dir, 'accepted-save.txt');
  const running = await launchPanel('save', dir);
  const panel = await status(running);
  assert.equal(panel.kind, 'save');
  assert.equal(panel.pending, true);
  assert.equal(panel.name, 'initial-name.txt');

  const response = await sendPanelRequest(
    running.chrome,
    { action: 'accept', path: target, panelId: panel.id },
    { runDir }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.dismissed, true);
  assert.equal(response.interceptedBeforeDisplay, true);
  const complete = await running.nextLine();
  assert.equal(complete.done, true, running.stderr());
  assert.equal(complete.result, 1, running.stderr());
  assert.equal(complete.url, target);
  assert.equal(complete.visible, false);
  assert.equal(complete.sampledVisiblePanel, false, 'Save panel was presented instead of intercepted');
});

test('pending native panel cancels without ever displaying', async () => {
  const running = await launchPanel('save', dir);
  const panel = await status(running);
  assert.equal(panel.pending, true);
  const response = await sendPanelRequest(
    running.chrome,
    { action: 'cancel', panelId: panel.id },
    { runDir }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.dismissed, true);
  assert.equal(response.interceptedBeforeDisplay, true);
  const complete = await running.nextLine();
  assert.equal(complete.result, 0, running.stderr());
  // NSSavePanel.URL remains the configured candidate even when AppKit returns
  // Cancel. The modal result, not a null URL, is the authoritative outcome.
  assert.match(complete.url, /initial-name\.txt$/);
  assert.equal(complete.visible, false);
});

test('stale requests are rejected without acting on the pending panel', async () => {
  const running = await launchPanel('save', dir);
  const oldResponse = await sendPanelRequest(
    running.chrome,
    { action: 'cancel', panelId: 'stale-does-not-matter' },
    { runDir, createdAtMs: Date.now() - 20_000 }
  );
  assert.equal(oldResponse.ok, false, JSON.stringify(oldResponse));
  assert.equal(oldResponse.error.code, 'STALE_REQUEST');
  const futureResponse = await sendPanelRequest(
    running.chrome,
    { action: 'cancel', panelId: 'future-does-not-matter' },
    { runDir, createdAtMs: Date.now() + 20_000 }
  );
  assert.equal(futureResponse.ok, false, JSON.stringify(futureResponse));
  assert.equal(futureResponse.error.code, 'STALE_REQUEST');
  const panel = await status(running);
  assert.equal(panel.pending, true, 'stale cancel changed panel state');
  const cancel = await sendPanelRequest(
    running.chrome,
    { action: 'cancel', panelId: panel.id },
    { runDir }
  );
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  const complete = await running.nextLine();
  assert.equal(complete.result, 0, running.stderr());
});

test('a visible-session panel is not intercepted and can still be cancelled', async () => {
  const running = await launchPanel('save', dir, { visible: true });
  const panel = await status(running);
  assert.equal(panel.pending, false);
  const response = await sendPanelRequest(
    running.chrome,
    { action: 'cancel', panelId: panel.id },
    { runDir }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.interceptedBeforeDisplay, false);
  const complete = await running.nextLine();
  assert.equal(complete.result, 0, running.stderr());
  assert.equal(complete.visible, false);
});

test('showing the session releases a pending panel to the human fallback', async () => {
  const running = await launchPanel('save', dir);
  assert.equal((await status(running)).pending, true);
  rmSync(running.hiddenFlag, { force: true });
  await sleep(250);
  const panel = await status(running);
  assert.equal(panel.pending, false);
  const response = await sendPanelRequest(
    running.chrome,
    { action: 'cancel', panelId: panel.id },
    { runDir }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  const complete = await running.nextLine();
  assert.equal(complete.result, 0, running.stderr());
  assert.equal(complete.sampledVisiblePanel, true, 'fallback panel was never presented');
  assert.ok(complete.maxWindowServerAlpha > 0, 'human fallback stayed transparent');
});

test('native Open panel selects and accepts the exact existing path', async () => {
  const target = join(dir, 'open-me.txt');
  writeFileSync(target, 'panel integration fixture\n');
  const running = await launchPanel('open', dir);
  const panel = await status(running);
  assert.equal(panel.kind, 'open');
  assert.equal(panel.pending, true);

  const response = await sendPanelRequest(
    running.chrome,
    { action: 'accept', path: target, panelId: panel.id },
    { runDir, timeoutMs: 7_000 }
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.interceptedBeforeDisplay, true);
  const complete = await running.nextLine();
  assert.equal(complete.result, 1, running.stderr());
  assert.equal(complete.url, target);
  assert.equal(complete.visible, false);
  assert.equal(complete.maxAppKitAlpha, 0, 'intercepted Open panel became opaque in AppKit');
  assert.equal(complete.maxWindowServerAlpha, 0, 'intercepted Open panel was composited visibly');
  assert.equal(complete.becameActive, false, 'intercepted Open panel took the foreground');
  assert.equal(existsSync(running.automationFlag), false, 'automation marker survived panel dismissal');
});
