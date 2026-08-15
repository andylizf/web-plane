import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sendPanelRequest } from '../../lib/panel.js';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';
import {
  buildRuntime,
  finishLaunchTransition,
  keepDisplayAwake,
  killQuietly,
  launchClone,
  requireMacGui,
} from '../helpers/browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let home;
let paths;
let browser;
let releaseDisplay;

before(() => {
  requireMacGui();
  home = makeTmpDir('chrome-panel');
  paths = buildRuntime(home);
  releaseDisplay = keepDisplayAwake();
});

after(() => {
  if (browser?.pid) killQuietly(browser.pid);
  releaseDisplay?.();
  if (home) removeTmpDir(home);
});

function frontmostPid() {
  return Number(
    execFileSync('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier',
    ], { encoding: 'utf8' }).trim()
  );
}

async function pageClient(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Chrome has no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  return {
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const id = (Math.random() * 1e9) | 0;
        ws.addEventListener('message', function handler(event) {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          ws.removeEventListener('message', handler);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression } }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function waitForPanel(chrome, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sendPanelRequest(chrome, { action: 'status' }, { runDir: paths.runDir });
    if (last.ok && last.panel) return last.panel;
    await sleep(50);
  }
  assert.fail(`real Chrome did not create a native panel: ${JSON.stringify(last)}`);
}

test('real hidden Chrome download is saved through the native panel bridge', async () => {
  const session = 'real-panel';
  const profile = join(paths.profilesDir, session, 'Default');
  const downloadDir = join(home, 'downloads');
  mkdirSync(profile, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
  writeFileSync(
    join(profile, 'Preferences'),
    JSON.stringify({
      download: {
        default_directory: downloadDir,
        prompt_for_download: true,
      },
    })
  );

  browser = await launchClone({ paths, session });
  await finishLaunchTransition(browser);
  const frontBefore = frontmostPid();
  const page = await pageClient(browser.port);
  await page.evaluate(`(() => {
    const link = document.createElement('a');
    link.href = 'data:text/plain;charset=utf-8,web-plane-real-panel%0A';
    link.download = 'suggested-name.txt';
    document.body.appendChild(link);
    link.click();
    return true;
  })()`);
  page.close();

  const chrome = { pid: browser.pid, runId: browser.runId, managed: true };
  const panel = await waitForPanel(chrome);
  assert.equal(panel.kind, 'save');
  assert.equal(panel.pending, true, 'real Chrome Save panel was shown before interception');

  const target = join(downloadDir, 'accepted-real-download.txt');
  const accepted = await sendPanelRequest(
    chrome,
    { action: 'accept', path: target, panelId: panel.id },
    { runDir: paths.runDir }
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const deadline = Date.now() + 5_000;
  while (!existsSync(target) && Date.now() < deadline) await sleep(50);
  assert.equal(existsSync(target), true, 'Chrome did not write the accepted download path');
  assert.equal(readFileSync(target, 'utf8'), 'web-plane-real-panel\n');

  const state = await sendPanelRequest(chrome, { action: 'status' }, { runDir: paths.runDir });
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.panel, null, 'panel remained after the download completed');
  assert.equal(frontmostPid(), frontBefore, 'real Chrome Save flow changed the foreground app');
});
