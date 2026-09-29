import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

// A caller whose environment names a proxy with credentials (an agent host
// routing its own API traffic) once made each lane's agent-browser daemon
// intercept every request in the shared Chrome. When a daemon then lost the
// CDP session that interception belonged to, every tab stalled until the
// daemon exited. The invariant tested here is the one that failure broke: a
// page's own requests never wait on its driver process. NO_PROXY keeps the
// driver's loopback CDP discovery direct, as a proxy that forwards loopback
// does; nothing listens on port 9.
const home = makeTmpDir('proxy-env-oopif');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `p${process.pid}`);
const session = `px${process.pid}`;
const lane = `oopif${process.pid}`;
const proxy = 'http://user:secret@127.0.0.1:9';
const proxyEnv = {
  HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
  http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
let server;
let port;

// The install fetches packages, so only the lane commands see the proxy.
function cli(args, { env = proxyEnv, timeout = 70_000 } = {}) {
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

async function lanePage(cdpPort) {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
  return targets.find((t) => t.type === 'page' && t.url === `http://127.0.0.1:${port}/`);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Run a same-origin fetch in the page over our own CDP connection. */
async function pageFetch(page, timeoutMs) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await once(ws, 'open');
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(`no answer in ${timeoutMs}ms`), timeoutMs);
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        resolve(message.result?.result?.value ?? JSON.stringify(message));
      });
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: "fetch('/ping').then((r) => r.text())", awaitPromise: true },
      }));
    });
  } finally {
    ws.close();
  }
}

function daemonPid(name) {
  return Number(readFileSync(join(socketDir, `${name}.pid`), 'utf8').trim());
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  server = spawn(process.execPath, [join(REPO_ROOT, 'tests', 'fixtures', 'oopif-server.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [line] = await once(createInterface({ input: server.stdout }), 'line');
  port = JSON.parse(line).port;
  console.log('proxy-env-oopif: installing an isolated exact-checkout runtime');
  const installed = cli(['install'], { env: {} });
  assert.equal(installed.code, 0, installed.all);
});

after(async () => {
  try { cli([`-s=${session}`, 'close']); } catch {}
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test("a proxy in the caller's environment does not put the driver in the page's request path", async () => {
  const attached = cli([`-s=${session}`, 'attach', '--as', lane, `http://127.0.0.1:${port}/`]);
  assert.equal(attached.code, 0, attached.all);
  const state = laneState(lane);
  assert.ok(state?.port > 0, `missing state for ${lane}`);
  assert.ok(await waitFor(async () => (await lanePage(state.port))?.title === 'Fetched pong', 15_000),
    'the page never framed its cross-site child and finished its fetch');

  // A stopped daemon answers nothing, exactly like one whose CDP session for
  // an intercepted target is gone.
  const pid = daemonPid(lane);
  process.kill(pid, 'SIGSTOP');
  let answer;
  try {
    answer = await pageFetch(await lanePage(state.port), 5_000);
  } finally {
    process.kill(pid, 'SIGCONT');
  }
  assert.equal(answer, 'pong', 'a same-origin fetch waited on the lane driver');

  const closed = cli(['lane', lane, 'close']);
  assert.equal(closed.code, 0, closed.all);
});
