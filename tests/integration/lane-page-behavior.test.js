import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CdpConnection } from '../../lib/cdp-client.js';
import { detectCanvasPage, evalAllFrames } from '../../lib/page-diagnostics.js';
import { RUNTIME_VERSION } from '../../lib/config.js';
import {
  buildRuntime,
  finishLaunchTransition,
  killQuietly,
  launchClone,
  requireMacGui,
} from '../helpers/browser.js';
import { runCli } from '../helpers/cli.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

const home = makeTmpDir('lane-page-behavior');
const socketDir = join(REPO_ROOT, 'tmp', `s-${process.pid}`);
const lane = 'lpb';
const session = 'lpb-profile';
let runtime;
let chrome;
let targetId;

function cli(args) {
  return runCli(args, { home, env: { AGENT_BROWSER_SOCKET_DIR: socketDir } });
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true });
  runtime = buildRuntime(home);
  writeFileSync(join(runtime.runtime, 'runtime-version'), `${RUNTIME_VERSION}\n`);
  chrome = await launchClone({ paths: runtime, session });
  await finishLaunchTransition(chrome);

  const connected = cli(['agent-browser', '--session', lane, '--no-pin-tab', 'connect', String(chrome.port)]);
  assert.equal(connected.code, 0, connected.all);
  const opened = cli(['agent-browser', '--session', lane, '--pin-tab', 'tab', 'new', '--label', lane]);
  assert.equal(opened.code, 0, opened.all);
  const listed = cli(['agent-browser', '--session', lane, 'tab', 'list', '--json']);
  assert.equal(listed.code, 0, listed.all);
  targetId = JSON.parse(listed.stdout).data.tabs.find((tab) => tab.active)?.targetId;
  assert.ok(targetId, listed.stdout);

  mkdirSync(join(runtime.runtime, 'lanes'), { recursive: true });
  writeFileSync(
    join(runtime.runtime, 'lanes', `${lane}.json`),
    JSON.stringify({ session, port: chrome.port })
  );

  const cdp = await CdpConnection.connect(chrome.port);
  const pageSession = await cdp.attachTarget(targetId);
  const html = `<!doctype html>
    <style>
      #target, #cover { position: fixed; left: 20px; top: 20px; width: 220px; height: 60px; }
      #target { z-index: 1; } #cover { z-index: 2; background: rgba(0,0,0,.1); }
      canvas { display: block; width: 90vw; height: 70vh; margin-top: 100px; }
    </style>
    <button id="target">Covered action</button><div id="cover"></div>
    <canvas width="900" height="500"></canvas>
    <label>Username <input aria-label="Username" value="agent"></label>
    <label>Empty <input aria-label="Empty" value=""></label>
    <label>Password <input aria-label="Password" type="password" value="old-secret"></label>
    <label><input aria-label="Remember" type="checkbox" checked> Remember</label>
    <label>Country <select aria-label="Country"><option>Canada</option><option selected>United States</option></select></label>
    <iframe title="Nested form" srcdoc='<label>State <input aria-label="State" value="USA"></label>'></iframe>
    <script>
      window.forceHits = [];
      window.coverHits = 0;
      document.querySelector('#target').addEventListener('click', event => forceHits.push(event.isTrusted));
      document.querySelector('#cover').addEventListener('click', () => coverHits++);
    <\/script>`;
  await cdp.send('Runtime.evaluate', {
    expression: `document.open(); document.write(${JSON.stringify(html)}); document.close();`,
  }, pageSession);
  await new Promise((resolve) => setTimeout(resolve, 300));
  cdp.close();
});

after(() => {
  try { cli(['agent-browser', '--session', lane, 'close']); } catch {}
  if (chrome) killQuietly(chrome.pid);
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('lane operations are frame-aware, focus-aware, canvas-aware, ready, and tab-scoped', async () => {
  const frameResults = await evalAllFrames(chrome.port, targetId, 'location.href');
  assert.ok(frameResults.length >= 2, JSON.stringify(frameResults));
  assert.ok(frameResults.every((frame) => !frame.error), JSON.stringify(frameResults));

  const allFrames = cli(['lane', lane, 'eval', '--all-frames', 'document.activeElement?.tagName']);
  assert.equal(allFrames.code, 0, allFrames.all);
  assert.ok(JSON.parse(allFrames.stdout).frames.length >= 2, allFrames.stdout);

  const snapshot = cli(['lane', lane, 'snapshot']);
  assert.equal(snapshot.code, 0, snapshot.all);
  assert.match(snapshot.stderr, /canvas-rendered/);
  assert.match(snapshot.stderr, /screenshot/);
  assert.match(snapshot.stdout, /textbox "Username" \[[^\]]*value="agent"/);
  assert.match(snapshot.stdout, /textbox "Empty" \[[^\]]*value=""/);
  assert.match(snapshot.stdout, /textbox "Password" \[[^\]]*value=<10 chars>/);
  assert.doesNotMatch(snapshot.stdout, /old-secret/);
  assert.match(snapshot.stdout, /checkbox "Remember" \[[^\]]*checked=true/);
  assert.match(snapshot.stdout, /combobox "Country" \[[^\]]*value="United States"/);
  assert.ok((await detectCanvasPage(chrome.port, targetId)).coverage >= 0.25);
  const ref = snapshot.stdout.match(/textbox "State"[^\n]*ref=(e\d+)/)?.[1];
  assert.ok(ref, snapshot.stdout);

  const replaced = cli(['lane', lane, 'type', ref, 'NY']);
  assert.equal(replaced.code, 0, replaced.all);
  assert.match(replaced.stderr, /verified field value "NY"/);

  const semantic = cli(['lane', lane, 'find', 'role', 'textbox', 'fill', 'TX', '--name', 'State']);
  assert.equal(semantic.code, 0, semantic.all);
  assert.match(semantic.stderr, /verified field value "TX"/);
  const appended = cli(['lane', lane, 'type', ref, '!', '--append']);
  assert.equal(appended.code, 0, appended.all);
  assert.match(appended.stderr, /verified field value "TX!"/);
  const semanticValue = await evalAllFrames(chrome.port, targetId, 'document.querySelector("input")?.value');
  assert.ok(semanticValue.some((frame) => frame.value === 'TX!'), JSON.stringify(semanticValue));

  const passwordRef = snapshot.stdout.match(/textbox "Password"[^\n]*ref=(e\d+)/)?.[1];
  assert.ok(passwordRef, snapshot.stdout);
  const password = cli(['lane', lane, 'fill', passwordRef, 'new-secret']);
  assert.equal(password.code, 0, password.all);
  assert.match(password.stderr, /verified password field value <10 chars>/);
  assert.doesNotMatch(password.all, /new-secret/);

  const emptyRef = snapshot.stdout.match(/textbox "Empty"[^\n]*ref=(e\d+)/)?.[1];
  assert.ok(emptyRef, snapshot.stdout);
  const filledEmpty = cli(['lane', lane, 'fill', emptyRef, 'A']);
  assert.equal(filledEmpty.code, 0, filledEmpty.all);
  assert.match(filledEmpty.stderr, /verified field value "A"/);
  const clearedEmpty = cli(['lane', lane, 'clear', emptyRef]);
  assert.equal(clearedEmpty.code, 0, clearedEmpty.all);
  assert.match(clearedEmpty.stderr, /verified field value ""/);

  const cdp = await CdpConnection.connect(chrome.port);
  const pageSession = await cdp.attachTarget(targetId);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('iframe').contentDocument.querySelector('input');
      input.value = 'USA'; input.focus();
    })()`,
  }, pageSession);
  cdp.close();

  const selectAll = cli(['lane', lane, 'key', 'Meta+a']);
  assert.equal(selectAll.code, 0, selectAll.all);
  assert.match(selectAll.stderr, /key target: input/);
  assert.match(selectAll.stderr, /State/);
  const remove = cli(['lane', lane, 'key', 'Delete']);
  assert.equal(remove.code, 0, remove.all);
  const cleared = await evalAllFrames(chrome.port, targetId, 'document.querySelector("input")?.value');
  assert.ok(cleared.some((frame) => frame.value === ''), JSON.stringify(cleared));

  const covered = cli(['lane', lane, 'click', '#target']);
  assert.notEqual(covered.code, 0, covered.all);
  assert.match(covered.all, /covered/);
  const forced = cli(['lane', lane, 'click', '#target', '--force']);
  assert.equal(forced.code, 0, forced.all);
  assert.match(forced.stderr, /forced a real mouse click/);
  const clickEvidence = await evalAllFrames(
    chrome.port,
    targetId,
    '({ forceHits: window.forceHits, coverHits: window.coverHits })'
  );
  const topEvidence = clickEvidence.find((frame) => Array.isArray(frame.value?.forceHits));
  assert.deepEqual(topEvidence?.value, { forceHits: [true], coverHits: 0 });

  const readyUrl = 'data:text/html,<main id="ready">ready</main>';
  const navigated = cli([
    'lane', lane, 'navigate', readyUrl,
    '--wait-for', '#ready', '--timeout', '5000',
  ]);
  assert.equal(navigated.code, 0, navigated.all);

  const siblingCdp = await CdpConnection.connect(chrome.port);
  const sibling = await siblingCdp.send('Target.createTarget', { url: 'about:blank' });
  siblingCdp.close();
  const closed = cli(['lane', lane, 'close']);
  assert.equal(closed.code, 0, closed.all);
  assert.equal((await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).ok, true);
  const remaining = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  assert.ok(remaining.some((target) => target.id === sibling.targetId), JSON.stringify(remaining));
});
