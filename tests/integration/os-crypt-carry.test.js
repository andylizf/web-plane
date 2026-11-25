import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

// Chrome 158 stopped reading the v10 key in non-default user-data-dirs and
// dropped every cookie a 155-era web-plane profile held on its first launch.
// This builds such a profile for real — the clone writes a cookie, then the
// profile is put back on v10 exactly as Chrome 155 left it — and asks whether
// the page still sees its cookie after web-plane opens the profile again.
const home = makeTmpDir('os-crypt-carry');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `oc${process.pid}`);
const session = `oc${process.pid}`;
const lane = `ocl${process.pid}`;
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const { decryptValue, migrateProfileEncryption } = await import('../../lib/os-crypt.js');
let server;
let origin;

function cli(args, { timeout = 70_000 } = {}) {
  return runCli(args, {
    home,
    timeout,
    env: { WEB_PLANE_RUNTIME_DIR: runtime, AGENT_BROWSER_SOCKET_DIR: socketDir },
  });
}

function cookieTags() {
  const db = join(runtime, 'profiles', session, 'Default', 'Cookies');
  const out = execFileSync('sqlite3', ['-json', `file:${db}?mode=ro&immutable=1`,
    `select host_key as host, name, hex(encrypted_value) as v from cookies where name = 'wp_keep'`], { encoding: 'utf8' });
  return JSON.parse(out || '[]');
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  // Its own process: the CLI runs under spawnSync, which blocks this one's event
  // loop, so an in-process server would never answer the page load.
  server = spawn(process.execPath, ['-e', `
    const s = require('node:http').createServer((q, r) => r.end('<title>carry</title>ok'));
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve));
  origin = `http://127.0.0.1:${port}/`;
  const installed = cli(['install']);
  assert.equal(installed.code, 0, installed.all);
  assert.match(installed.stdout, /encrypts with v1[01]/);
});

after(() => {
  try { cli([`-s=${session}`, 'close']); } catch {}
  if (server && server.exitCode === null) server.kill('SIGTERM');
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('a profile on the old v10 key keeps its cookie when web-plane opens it again', async () => {
  const { tag } = JSON.parse(readFileSync(join(runtime, 'os-crypt.json'), 'utf8'));
  const old = tag === 'v11' ? 'v10' : 'v11';

  assert.equal(cli([`-s=${session}`, 'attach', '--as', lane, origin]).code, 0);
  const set = cli(['lane', lane, 'eval', `document.cookie = 'wp_keep=still-here; max-age=86400'`]);
  assert.equal(set.code, 0, set.all);
  // Chrome commits cookies to disk in 30-second batches, and a SIGTERM close
  // does not flush the pending one, so wait for the row before closing.
  const deadline = Date.now() + 60_000;
  while (!cookieTags().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  assert.equal(cli([`-s=${session}`, 'close']).code, 0);
  assert.equal(cookieTags()[0]?.v.slice(0, 6), Buffer.from(tag).toString('hex').toUpperCase());

  // The state a Chrome-upgrade leaves behind: values on the key it no longer reads.
  const back = migrateProfileEncryption(session, old);
  assert.ok(back.migrated >= 1, JSON.stringify(back));
  assert.equal(cookieTags()[0].v.slice(0, 6), Buffer.from(old).toString('hex').toUpperCase());

  const reopened = cli([`-s=${session}`, 'attach', '--as', `${lane}b`, origin]);
  assert.equal(reopened.code, 0, reopened.all);
  const seen = cli(['lane', `${lane}b`, 'eval', 'document.cookie']);
  assert.equal(seen.code, 0, seen.all);
  assert.match(seen.stdout, /wp_keep=still-here/);
  assert.match(reopened.stderr, new RegExp(`re-encrypted \\d+ cookie/login value\\(s\\) in '${session}' for this Chrome's ${tag} key`));
  assert.equal(cli([`-s=${session}`, 'close']).code, 0);

  const [row] = cookieTags();
  assert.ok(decryptValue(tag, Buffer.from(row.v, 'hex')), 'the cookie is back on the clone key');
});
