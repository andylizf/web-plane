import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { sendPanelRequest } from '../../lib/panel.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

let dir;
let dylib;
let host;
let runDir;

before(() => {
  dir = makeTmpDir('ui-blocker');
  dylib = join(dir, 'window_suppress.dylib');
  host = join(dir, 'ui_blocker_host');
  runDir = join(dir, 'run');
  mkdirSync(runDir, { mode: 0o700 });
  execFileSync('cc', [
    '-Wall', '-Werror', '-dynamiclib', '-framework', 'AppKit', '-framework', 'Foundation',
    '-o', dylib,
    join(REPO_ROOT, 'native', 'window_suppress.m'),
    join(REPO_ROOT, 'native', 'panel_control.m'),
  ]);
  execFileSync('cc', [
    '-Wall', '-Werror', '-framework', 'AppKit', '-framework', 'Foundation',
    '-o', host,
    join(REPO_ROOT, 'tests', 'native', 'ui_blocker_host.m'),
  ]);
  execFileSync('codesign', ['--force', '--sign', '-', host], { stdio: 'ignore' });
});

after(() => dir && removeTmpDir(dir));

async function launch(kind) {
  const runId = randomUUID();
  const proc = spawn(host, [kind], {
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: dylib,
      WEB_PLANE_RUN_ID: runId,
      WEB_PLANE_RUN_DIR: runDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => (stdout += chunk));
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const deadline = Date.now() + 3_000;
  while (!stdout.includes('\n') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stdout, /"event":"ready"/, stderr);
  return {
    proc,
    chrome: { pid: proc.pid, runId, managed: true },
  };
}

test('a keyable Chrome child window is reported as a browser-modal blocker', async () => {
  const running = await launch('modal');
  try {
    const response = await sendPanelRequest(
      running.chrome,
      { action: 'ui-status' },
      { runDir }
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.blockers.length, 1, JSON.stringify(response));
    assert.equal(response.blockers[0].kind, 'browser-modal');
    assert.equal(response.blockers[0].scope, 'tab');
    assert.equal(response.blockers[0].blocking, true);
    assert.equal(response.blockers[0].title, 'Arbitrary browser-owned UI');
    const repeated = await sendPanelRequest(
      running.chrome,
      { action: 'ui-status' },
      { runDir }
    );
    assert.equal(repeated.blockers[0].id, response.blockers[0].id);
  } finally {
    running.proc.kill('SIGTERM');
  }
});

test('an unparented Chrome popover is not treated as blocking page input', async () => {
  const running = await launch('popover');
  try {
    const response = await sendPanelRequest(
      running.chrome,
      { action: 'ui-status' },
      { runDir }
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(response.blockers, []);
  } finally {
    running.proc.kill('SIGTERM');
  }
});

test('an unsupported native panel is reported for an agent-controlled handoff', async () => {
  const running = await launch('native-panel');
  try {
    const response = await sendPanelRequest(
      running.chrome,
      { action: 'ui-status' },
      { runDir }
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.blockers.length, 1, JSON.stringify(response));
    assert.equal(response.blockers[0].kind, 'native-panel');
    assert.equal(response.blockers[0].subtype, 'unsupported');
    assert.equal(response.blockers[0].blocking, true);
  } finally {
    running.proc.kill('SIGTERM');
  }
});
