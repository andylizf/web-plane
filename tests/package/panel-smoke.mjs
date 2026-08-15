import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';

const bin = process.env.WEB_PLANE_BIN;
const runtime = process.env.WEB_PLANE_RUNTIME_DIR;
const work = process.env.WEB_PLANE_SMOKE_DIR;
assert.ok(bin && runtime && work, 'WEB_PLANE_BIN, WEB_PLANE_RUNTIME_DIR, and WEB_PLANE_SMOKE_DIR are required');
const expectedVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

const env = { ...process.env, WEB_PLANE_RUNTIME_DIR: runtime };
const session = 'package-panel';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (step, outcome, details = {}) => {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), step, outcome, ...details })}\n`);
};

function cli(args, { expect = 0 } = {}) {
  const result = spawnSync(bin, args, { env, encoding: 'utf8' });
  if (result.status !== expect) {
    throw new Error(
      `web-plane ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result;
}

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return await response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`installed Chrome did not expose CDP on ${port}`);
}

async function cdpSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  let id = 0;
  return {
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        ws.addEventListener('message', function handler(event) {
          const message = JSON.parse(event.data);
          if (message.id !== requestId) return;
          ws.removeEventListener('message', handler);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function launchInstalledChrome() {
  const port = await freePort();
  const runId = randomUUID();
  const runDir = join(runtime, 'run');
  const profileDir = join(runtime, 'profiles', session);
  const chromeBin = join(runtime, 'Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const proc = spawn(chromeBin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--start-minimized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--use-mock-keychain',
    '--password-store=basic',
    'about:blank',
  ], {
    env: {
      ...env,
      DYLD_INSERT_LIBRARIES: join(runtime, 'window_suppress.dylib'),
      WEB_PLANE_RUN_ID: runId,
      WEB_PLANE_RUN_DIR: runDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const version = await waitForCdp(port).catch((error) => {
    throw new Error(`${error.message}\nChrome stderr:\n${stderr.slice(-2_000)}`);
  });

  // This is the launch hand-off performed by the installed Playwright patch.
  // The smoke test starts the installed clone directly because Playwright owns
  // webpage download/file-chooser events and intentionally bypasses native UI.
  rmSync(join(runDir, `.chrome-suppress-${runId}`), { force: true });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  assert.ok(page, 'installed Chrome has no page target');
  const browser = await cdpSocket(version.webSocketDebuggerUrl);
  const { windowId } = await browser.send('Browser.getWindowForTarget', { targetId: page.id });
  await browser.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  browser.close();
  return { proc, port };
}

async function triggerDownload(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'package Chrome has no page target');
  const pageCdp = await cdpSocket(page.webSocketDebuggerUrl);
  await pageCdp.send('Runtime.evaluate', {
    expression: `(() => {
      const link = document.createElement('a');
      link.href = 'data:text/plain;charset=utf-8,web-plane-package-panel%0A';
      link.download = 'suggested-package-name.txt';
      document.body.appendChild(link);
      link.click();
      return true;
    })()`,
  });
  pageCdp.close();
}

mkdirSync(work, { recursive: true });
const profile = join(runtime, 'profiles', session, 'Default');
const downloads = join(work, 'downloads');
mkdirSync(profile, { recursive: true });
mkdirSync(downloads, { recursive: true });
writeFileSync(
  join(profile, 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: true } })
);

let browserProcess = null;
try {
  const version = cli(['--version']).stdout.trim();
  assert.equal(version, expectedVersion);
  log('package-version', 'success', { version });

  const started = await launchInstalledChrome();
  browserProcess = started.proc;
  const { port } = started;
  const frontBefore = frontmostPid();
  log('hidden-launch', 'success', { port, frontBefore });

  await triggerDownload(port);

  const deadline = Date.now() + 5_000;
  let panel = null;
  while (Date.now() < deadline) {
    const state = JSON.parse(cli([`-s=${session}`, 'panel', 'status']).stdout);
    if (state.panel) {
      panel = state.panel;
      break;
    }
    await sleep(50);
  }
  assert.ok(panel, 'installed package did not report Chrome Save Page As panel');
  assert.equal(panel.kind, 'save');
  assert.equal(panel.pending, true);
  log('panel-status', 'success', { kind: panel.kind, pending: panel.pending });

  const target = join(downloads, 'package-accepted.txt');
  const accepted = JSON.parse(
    cli([`-s=${session}`, 'panel', 'accept', '--path', target]).stdout
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const fileDeadline = Date.now() + 5_000;
  while (!existsSync(target) && Date.now() < fileDeadline) await sleep(50);
  assert.equal(readFileSync(target, 'utf8'), 'web-plane-package-panel\n');
  log('panel-accept', 'success', { target, bytes: readFileSync(target).length });

  const finalPanel = JSON.parse(cli([`-s=${session}`, 'panel', 'status']).stdout);
  assert.equal(finalPanel.panel, null);
  const status = cli([`-s=${session}`, 'status']).stdout;
  assert.match(status, /Window:\s+hidden/);
  assert.equal(frontmostPid(), frontBefore);
  log('post-dismissal', 'success', { panel: null, window: 'hidden', frontPid: frontBefore });
} finally {
  if (browserProcess) {
    const closed = spawnSync(bin, [`-s=${session}`, 'close'], { env, encoding: 'utf8' });
    if (closed.status !== 0) browserProcess.kill('SIGKILL');
    log('cleanup', closed.status === 0 ? 'success' : 'failure', {
      exitCode: closed.status,
      stderr: closed.stderr.trim(),
    });
  }
}
