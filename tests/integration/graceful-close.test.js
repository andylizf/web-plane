import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { runCli } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

// Chrome writes cookies to disk in batches about 30 seconds apart. A SIGTERM
// ends it in tens of milliseconds without writing the pending batch, and even a
// graceful Browser.close was cut short by playwright-cli's daemon SIGKILLing
// Chrome's process group mid-shutdown, so a login completed just before `close`
// was gone at the next launch. Closing has to go through Chrome's own shutdown
// and let it finish.
const home = makeTmpDir('graceful-close');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `gc${process.pid}`);
const session = `gc${process.pid}`;
const lane = `gcl${process.pid}`;
let server;
let origin;

function cli(args, { timeout = 70_000 } = {}) {
  return runCli(args, {
    home,
    timeout,
    env: { WEB_PLANE_RUNTIME_DIR: runtime, AGENT_BROWSER_SOCKET_DIR: socketDir },
  });
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  // Its own process: the CLI runs under spawnSync, which blocks this one's event
  // loop, so an in-process server would never answer the page load.
  server = spawn(process.execPath, ['-e', `
    const s = require('node:http').createServer((q, r) => r.end('<title>close</title>ok'));
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve));
  origin = `http://127.0.0.1:${port}/`;
  const installed = cli(['install']);
  assert.equal(installed.code, 0, installed.all);
});

after(() => {
  try { cli([`-s=${session}`, 'close']); } catch {}
  if (server && server.exitCode === null) server.kill('SIGTERM');
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('a cookie set right before close is still there after the next launch', () => {
  assert.equal(cli([`-s=${session}`, 'attach', '--as', lane, origin]).code, 0);
  const set = cli(['lane', lane, 'eval', `document.cookie = 'wp_close=kept; max-age=86400'`]);
  assert.equal(set.code, 0, set.all);

  // No wait: well inside Chrome's 30-second write interval.
  const closed = cli([`-s=${session}`, 'close']);
  assert.equal(closed.code, 0, closed.all);
  assert.doesNotMatch(closed.stdout, /killed|SIGTERM/, closed.all);

  assert.equal(cli([`-s=${session}`, 'attach', '--as', `${lane}b`, origin]).code, 0);
  const seen = cli(['lane', `${lane}b`, 'eval', 'document.cookie']);
  assert.equal(seen.code, 0, seen.all);
  assert.match(seen.stdout, /wp_close=kept/);
});
