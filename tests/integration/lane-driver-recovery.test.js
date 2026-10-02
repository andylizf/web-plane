import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';
import { CdpConnection } from '../../lib/cdp-client.js';

// What a lane is left with after something goes wrong in the page: a command
// that never returns, a sibling tab whose renderer stopped answering, or the
// lane's own tab wedged. Each must leave the lane, or the next attach, usable.
const home = makeTmpDir('lane-driver-recovery');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `d${process.pid}`);
const session = `dr${process.pid}`;
const lane = (name) => `${name}${process.pid}`;
const proxy = 'http://user:secret@127.0.0.1:9';
const proxyEnv = {
  HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
  http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
const fixture = (name) => pathToFileURL(join(home, `${name}.html`)).href;
let server;
let cdpPort;
let wedgedTargetId;

function cli(args, { env = {}, timeout = 70_000 } = {}) {
  return runCli(args, {
    home,
    timeout,
    env: { WEB_PLANE_RUNTIME_DIR: runtime, AGENT_BROWSER_SOCKET_DIR: socketDir, ...env },
  });
}

function laneState(name) {
  const key = createHash('sha256').update(name).digest('hex');
  const path = join(runtime, 'lanes', `${key}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

async function pages() {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
  return targets.filter((target) => target.type === 'page');
}

function activeTarget(name) {
  const listing = cli(['agent-browser', '--session', name, 'tab', 'list', '--json']);
  assert.equal(listing.code, 0, listing.all);
  return JSON.parse(listing.stdout).data.tabs.find((tab) => tab.active)?.targetId;
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  for (const name of ['a', 'b', 'c', 'd']) {
    writeFileSync(join(home, `${name}.html`), `<!doctype html><title>${name}</title><main>FIXTURE_${name}</main>\n`);
  }
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<title>wedged</title><script>setTimeout(() => { for (;;) {} }, 300)</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const installed = cli(['install']);
  assert.equal(installed.code, 0, installed.all);
  for (const name of ['a', 'b']) {
    const attached = cli([`-s=${session}`, 'attach', '--as', lane(name), fixture(name)]);
    assert.equal(attached.code, 0, attached.all);
  }
  cdpPort = laneState(lane('a')).port;
});

after(() => {
  try { cli([`-s=${session}`, 'close']); } catch {}
  server?.close();
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('a timed-out eval leaves the same lane usable and still pinned to its tab', () => {
  const name = lane('a');
  const pinned = laneState(name).targetId;
  const hung = cli(['lane', name, 'eval', 'new Promise(() => {})'], {
    env: { WEB_PLANE_DRIVER_TIMEOUT_MS: '3000' },
  });
  assert.equal(hung.code, 124, hung.all);

  // The daemon used to keep running the abandoned evaluation, plus copies its
  // client re-sent, so this waited roughly 30 s behind them.
  const started = Date.now();
  const next = cli(['lane', name, 'eval', 'location.href'], { timeout: 20_000 });
  assert.equal(next.code, 0, next.all);
  assert.ok(Date.now() - started < 10_000, `the next command took ${Date.now() - started} ms`);
  assert.match(next.stdout, /a\.html/);
  assert.equal(activeTarget(name), pinned);
});

test('re-attaching a lane after its driver restarted reuses the lane\'s tab', async () => {
  const name = lane('a');
  const pinned = laneState(name).targetId;
  const before = (await pages()).length;
  const attached = cli([`-s=${session}`, 'attach', '--as', name, fixture('a')]);
  assert.equal(attached.code, 0, attached.all);
  assert.equal(laneState(name).targetId, pinned);
  assert.equal((await pages()).length, before);
});

test('a wedged tab in the profile does not stop another lane attaching under a credentialed proxy', async () => {
  const connection = await CdpConnection.connect(cdpPort);
  try {
    ({ targetId: wedgedTargetId } = await connection.send('Target.createTarget', {
      url: `http://127.0.0.1:${server.address().port}/`, background: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const sessionId = await connection.attachTarget(wedgedTargetId);
    await assert.rejects(
      connection.send('Runtime.evaluate', { expression: '1' }, sessionId, 2_000),
      /timed out/,
      'the fixture tab must stop answering CDP'
    );
  } finally {
    connection.close();
  }

  // agent-browser installs request interception on every tab when its
  // environment names a proxy with credentials, and Page.enable on the wedged
  // tab never answers, so connect used to time out after 20 s.
  const started = Date.now();
  const attached = cli([`-s=${session}`, 'attach', '--as', lane('c'), fixture('c')], { env: proxyEnv });
  assert.equal(attached.code, 0, attached.all);
  assert.ok(Date.now() - started < 15_000, `attach took ${Date.now() - started} ms`);
});

test('a connect that times out names the tab that does not answer, and whose it is', () => {
  assert.ok(wedgedTargetId, 'needs the wedged tab from the previous test');
  const driver = join(home, 'connect-hangs');
  writeFileSync(driver, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('agent-browser 0.34.0');
else if (args.includes('connect')) setInterval(() => {}, 1000);
`);
  chmodSync(driver, 0o755);
  const attached = cli([`-s=${session}`, 'attach', '--as', lane('e'), fixture('a')], {
    env: { WEB_PLANE_TEST_AGENT_BROWSER_BIN: driver },
  });
  assert.equal(attached.code, 124, attached.all);
  assert.match(attached.stderr, new RegExp(`${wedgedTargetId} http://127\\.0\\.0\\.1:\\d+/ \\(not a web-plane lane`));
  assert.doesNotMatch(attached.stderr, new RegExp(laneState(lane('a')).targetId), 'a responsive tab is not blamed');
  assert.match(attached.stderr, /Retry: web-plane/);
});

function wedge(name) {
  const wedged = cli(['lane', name, 'eval', 'for (;;) {}'], { env: { WEB_PLANE_DRIVER_TIMEOUT_MS: '3000' } });
  assert.equal(wedged.code, 124, wedged.all);
  assert.match(wedged.stderr, /tab no longer answers CDP/);
}

test('a lane whose own tab stops answering is replaced on re-attach and closes promptly', async () => {
  const name = lane('d');
  const attached = cli([`-s=${session}`, 'attach', '--as', name, fixture('d')]);
  assert.equal(attached.code, 0, attached.all);
  const first = laneState(name).targetId;
  wedge(name);

  let started = Date.now();
  const reattached = cli([`-s=${session}`, 'attach', '--as', name, fixture('d')], { timeout: 30_000 });
  assert.equal(reattached.code, 0, reattached.all);
  assert.ok(Date.now() - started < 15_000, `re-attach took ${Date.now() - started} ms`);
  const second = laneState(name).targetId;
  assert.notEqual(second, first);
  assert.ok(!(await pages()).some((page) => page.id === first), 'the wedged tab was closed');
  const read = cli(['lane', name, 'eval', 'document.title']);
  assert.equal(read.code, 0, read.all);
  assert.match(read.stdout, /"d"/);

  wedge(name);
  started = Date.now();
  const closed = cli(['lane', name, 'close'], { timeout: 30_000 });
  assert.equal(closed.code, 0, closed.all);
  assert.ok(Date.now() - started < 10_000, `close took ${Date.now() - started} ms`);
  assert.ok(!(await pages()).some((page) => page.id === second), 'the wedged tab is gone');
  assert.equal(laneState(name), null);
});
