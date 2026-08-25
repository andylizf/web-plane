import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildRuntime,
  finishLaunchTransition,
  killQuietly,
  launchClone,
  requireMacGui,
  waitFor,
} from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

const home = makeTmpDir('lane-diagnostics');
process.env.WEB_PLANE_RUNTIME_DIR = join(home, '.web-plane');
const { CdpConnection } = await import(`../../lib/cdp-client.js?test=${Date.now()}`);
const { readLaneEvents } = await import(`../../lib/lane-events.js?test=${Date.now()}`);
const { startLaneMonitor, stopLaneMonitor } = await import(
  `../../lib/lane-monitor.js?test=${Date.now()}`
);

let runtime;
let chrome;

before(async () => {
  requireMacGui();
  runtime = buildRuntime(home);
  chrome = await launchClone({ paths: runtime, session: 'diagnostics' });
  await finishLaunchTransition(chrome);
});

after(() => {
  stopLaneMonitor('diagnostic-lane');
  if (chrome) killQuietly(chrome.pid);
  removeTmpDir(home);
});

test('a detached monitor survives restart and retains frame, failure, and target-loss evidence', async () => {
  const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const targetId = targets.find((target) => target.type === 'page')?.id;
  assert.ok(targetId, 'real Chrome exposed no page target');

  const firstMonitor = await startLaneMonitor({
    lane: 'diagnostic-lane',
    session: 'diagnostics',
    port: chrome.port,
    targetId,
  });
  assert.ok(firstMonitor.pid > 1);
  const monitor = await startLaneMonitor({
    lane: 'diagnostic-lane',
    session: 'diagnostics',
    port: chrome.port,
    targetId,
  });
  assert.ok(monitor.pid > 1);
  assert.notEqual(monitor.pid, firstMonitor.pid);

  const cdp = await CdpConnection.connect(chrome.port);
  const pageSession = await cdp.attachTarget(targetId);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      console.error('web-plane console marker');
      setTimeout(() => { throw new Error('web-plane exception marker'); }, 0);
      fetch('http://127.0.0.1:1/web-plane-failure').catch(() => {});
      const frame = document.createElement('iframe');
      frame.srcdoc = '<script>console.error("web-plane frame marker")<\\/script>';
      document.body.append(frame);
    })()`,
  }, pageSession);

  const observed = await waitFor(
    () => readLaneEvents('diagnostics', 'diagnostic-lane'),
    (events) =>
      events.some((event) => event.type === 'console' && /console marker/.test(event.text)) &&
      events.some((event) => event.type === 'console' && /frame marker/.test(event.text)) &&
      events.some((event) => event.type === 'page-error' && /exception marker/.test(event.text)) &&
      events.some(
        (event) =>
          event.type === 'request-failed' &&
          event.url === 'http://127.0.0.1:1/web-plane-failure' &&
          /^net::/.test(event.errorText)
    ),
    { timeoutMs: 5000, everyMs: 100 }
  );

  assert.equal(observed.ok, true, JSON.stringify(observed.last, null, 2));
  assert.equal(
    observed.last.some((event) => Object.hasOwn(event, 'requestBody')),
    false,
    'diagnostic log retained a request body'
  );

  await cdp.send('Target.createTarget', { url: 'about:blank' });
  await cdp.send('Target.closeTarget', { targetId });
  const lost = await waitFor(
    () => readLaneEvents('diagnostics', 'diagnostic-lane'),
    (events) => events.some((event) => event.type === 'target-lost' && event.targetId === targetId),
    { timeoutMs: 5000, everyMs: 100 }
  );
  cdp.close();
  assert.equal(lost.ok, true, JSON.stringify(lost.last, null, 2));
});
