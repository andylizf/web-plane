import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';
import { runCli } from '../helpers/cli.js';

// The CLI is run as a subprocess here so the exit codes are the real ones. A
// command that fails while exiting 0 is this tool's characteristic bug, and only
// the process boundary can catch it.

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

// An empty $HOME: no runtime, no profiles, and — importantly — no way for these
// tests to touch a session the developer has open.
let home;
before(() => (home = makeTmpDir('cli-home')));
after(() => home && removeTmpDir(home));

test('the code needs the Node version package.json promises', () => {
  // `show`/`hide`/`status` open a CDP socket through the global WebSocket, which
  // does not exist before Node 22. Declaring a lower floor in `engines` is not a
  // cosmetic error: on the version it advertises, every window command throws
  // ReferenceError. This test is what makes the declared floor mean something —
  // CI runs it on exactly that version.
  assert.equal(typeof WebSocket, 'function', `no global WebSocket on ${process.version}`);
  assert.equal(typeof fetch, 'function', `no global fetch on ${process.version}`);
});

test('--version prints the version and nothing else', () => {
  const r = runCli(['--version'], { home });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('--help lists the commands that exist', () => {
  const r = runCli(['--help'], { home });
  assert.equal(r.code, 0);
  for (const cmd of ['doctor', 'profiles', 'attach', 'lane', 'show', 'hide', 'status']) {
    assert.match(r.stdout, new RegExp(`\\n  ${cmd}\\b`), `help does not document '${cmd}'`);
  }
});

test('`list` is refused rather than answered by playwright-cli', () => {
  // Proxying it succeeds and prints playwright-cli's own session registry, which
  // keeps names whose profile dirs are gone and omits profiles it never opened.
  // Believing it costs a real login: you conclude the user's profile isn't there
  // and start a fresh logged-out one.
  const r = runCli(['list'], { home });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /web-plane profiles/);
});

test('a proxied command on an unconfigured machine says so instead of half-working', () => {
  const r = runCli(['snapshot'], { home });
  assert.equal(r.code, 1);
  assert.match(r.all, /not set up\. Run: web-plane install/);
});

test("status reports no session rather than the user's own Chrome", () => {
  // The developer running this may well have Chrome open. web-plane must not
  // claim it: it has no suppression hook, and a SIGUSR1 to it would kill it.
  const r = runCli(['status'], { home });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No browser session running\./);
});

test('close never claims success for a session it could not find', () => {
  const r = runCli(['-s=definitely-not-running', 'close'], { home });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.all, /Closed session/);
});
