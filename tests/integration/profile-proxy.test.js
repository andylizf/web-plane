import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

// A profile with a proxy must browse through it — names included — and a
// browser running through another exit must be refused rather than reused.
// The destination is a `.invalid` host that the SOCKS fixture answers itself:
// it cannot resolve locally, so the page loading at all proves Chrome handed
// the name to the proxy.
const home = makeTmpDir('profile-proxy');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `pp${process.pid}`);
const proxied = `pp${process.pid}`;
const direct = `pd${process.pid}`;
const lane = `ppl${process.pid}`;
let socks;
let socksPort;
const connects = [];

function cli(args, { timeout = 70_000 } = {}) {
  return runCli(args, {
    home,
    timeout,
    env: { WEB_PLANE_RUNTIME_DIR: runtime, AGENT_BROWSER_SOCKET_DIR: socketDir },
  });
}

function chromeCommandLine(session) {
  const out = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  const flag = `--user-data-dir=${join(runtime, 'profiles', session)}`;
  return out.split('\n').find((line) => !line.includes('Helper') && line.split(/\s+/).includes(flag)) ?? '';
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  socks = spawn(process.execPath, [join(REPO_ROOT, 'tests', 'fixtures', 'socks5-server.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: socks.stdout });
  socksPort = await new Promise((resolve) => {
    lines.on('line', (line) => {
      const record = JSON.parse(line);
      if (record.port && !record.host) resolve(record.port);
      else connects.push(record);
    });
  });
  console.log('profile-proxy: installing an isolated exact-checkout runtime');
  const installed = cli(['install']);
  assert.equal(installed.code, 0, installed.all);
});

after(async () => {
  for (const session of [proxied, direct]) {
    try { cli([`-s=${session}`, 'close']); } catch {}
  }
  if (socks && socks.exitCode === null) socks.kill('SIGTERM');
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('a profile launched with --proxy browses through it, names resolved proxy-side', async () => {
  const attached = cli([
    `-s=${proxied}`, 'attach', '--as', lane, 'http://proxy-check.invalid/',
    '--proxy', `socks5h://127.0.0.1:${socksPort}`,
  ]);
  assert.equal(attached.code, 0, attached.all);
  assert.match(attached.stderr, new RegExp(`now exits through socks5://127\\.0\\.0\\.1:${socksPort}`));

  const title = cli(['lane', lane, 'get', 'title']);
  assert.equal(title.code, 0, title.all);
  assert.match(title.stdout, /via socks proxy-check\.invalid/);
  // The CLI runs synchronously, so the fixture's records are read only now.
  await waitFor(() => connects.length > 0, 5_000);
  assert.ok(
    connects.some((c) => c.atyp === 'domain' && c.host === 'proxy-check.invalid'),
    `Chrome did not send the hostname to the proxy: ${JSON.stringify(connects)}`
  );

  const line = chromeCommandLine(proxied);
  assert.match(line, new RegExp(`--proxy-server=socks5://127\\.0\\.0\\.1:${socksPort}(\\s|$)`), line);
  assert.doesNotMatch(line, /--enable-automation/, 'the proxy launch lost stealth');

  const webdriver = cli(['lane', lane, 'eval', 'navigator.webdriver']);
  assert.equal(webdriver.code, 0, webdriver.all);
  assert.match(webdriver.stdout.trim(), /^false$/m);

  const status = cli([`-s=${proxied}`, 'status']);
  assert.match(status.stdout, /Window:\s+hidden/, status.all);
  assert.match(status.stdout, new RegExp(`Exit:\\s+socks5://127\\.0\\.0\\.1:${socksPort}`));
  const listing = cli(['profiles']);
  assert.match(listing.stdout, new RegExp(`${proxied}\\s+running.*socks5://127\\.0\\.0\\.1:${socksPort}`));
});

test('a running proxied browser is not switched to another exit, by attach or by proxy set', () => {
  const other = cli([
    `-s=${proxied}`, 'attach', '--as', `${lane}b`, 'http://other.invalid/',
    '--proxy', 'socks5://127.0.0.1:9',
  ]);
  assert.equal(other.code, 1, other.all);
  assert.match(other.stderr, new RegExp(`cannot switch[\\s\\S]*web-plane -s=${proxied} close`));

  const cleared = cli([`-s=${proxied}`, 'proxy', 'clear']);
  assert.equal(cleared.code, 1, cleared.all);
  const shown = cli([`-s=${proxied}`, 'proxy']);
  assert.match(shown.stdout, new RegExp(`Exit:\\s+socks5://127\\.0\\.0\\.1:${socksPort}`));

  // Without --proxy the stored exit still applies and the browser is reused.
  const again = cli([`-s=${proxied}`, 'attach', '--as', `${lane}c`, 'http://again.invalid/']);
  assert.equal(again.code, 0, again.all);
  assert.equal(cli(['lane', `${lane}c`, 'close']).code, 0);
  assert.equal(cli(['lane', lane, 'close']).code, 0);
});

test('a browser running direct is refused when the profile asks for a proxy', async () => {
  const started = cli([`-s=${direct}`, 'cdp']);
  assert.equal(started.code, 0, started.all);
  const refused = cli([
    `-s=${direct}`, 'attach', '--as', `${lane}d`, 'http://direct.invalid/',
    '--proxy', `socks5://127.0.0.1:${socksPort}`,
  ]);
  assert.equal(refused.code, 1, refused.all);
  assert.match(refused.stderr, /running \(pid \d+\) with direct/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(connects.some((c) => c.host === 'direct.invalid'), false);
  assert.equal(cli([`-s=${direct}`, 'close']).code, 0);
});
