import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
  // agent-browser 0.34 declares Node 24 as its floor. CI runs these tests on the
  // exact major web-plane advertises, so lowering `engines` cannot make an
  // impossible dependency graph look supported.
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, process.version);
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
  for (const cmd of ['doctor', 'profiles', 'attach', 'lane', 'agent-browser', 'show', 'hide', 'status', 'panel', 'ui']) {
    assert.match(r.stdout, new RegExp(`\\n  ${cmd}\\b`), `help does not document '${cmd}'`);
  }
});

test('attach help exposes readiness flags without starting a browser', () => {
  const r = runCli(['attach', '--help'], { home });
  assert.equal(r.code, 0, r.all);
  for (const flag of ['--wait-for', '--timeout', '--no-wait']) assert.ok(r.stdout.includes(flag));
  assert.match(r.stdout, /Waits for load by default/);
});

test('lane help describes lane commands without requiring an attached lane', () => {
  const r = runCli(['lane', 'example', '--help'], { home });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Lane input:/);
  assert.match(r.stdout, /netlog --failed/);
  assert.match(r.stdout, /24-hour hard idle timeout/);
  assert.match(r.stdout, /Maximum Memory Saver/);
  assert.doesNotMatch(r.stdout, /One-time setup/);
});

test('removed keep and unkeep commands fail before Chrome or agent-browser are needed', () => {
  const runtime = join(home, 'keep-runtime');
  const lane = 'offline-lane';
  const laneDir = join(runtime, 'lanes');
  const statePath = join(
    laneDir,
    `${createHash('sha256').update(lane).digest('hex')}.json`
  );
  mkdirSync(laneDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    lane,
    session: 'offline-profile',
    port: 54321,
    targetId: 'gone-target',
    openedAt: '2026-08-28T00:00:00.000Z',
    lastCommandAt: '2026-08-28T00:00:00.000Z',
    keep: false,
    updatedAt: '2026-08-28T00:00:00.000Z',
  })}\n`, { mode: 0o600 });

  const kept = runCli(['lane', lane, 'keep'], {
    home,
    env: { WEB_PLANE_RUNTIME_DIR: runtime },
  });
  assert.equal(kept.code, 2, kept.all);
  assert.match(kept.stderr, /lane keep was removed/);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).keep, false);
  assert.doesNotMatch(kept.all, /agent-browser|recovery failed|not set up/);

  const unkept = runCli(['lane', lane, 'unkeep'], {
    home,
    env: { WEB_PLANE_RUNTIME_DIR: runtime },
  });
  assert.equal(unkept.code, 2, unkept.all);
  assert.match(unkept.stderr, /lane unkeep was removed/);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).keep, false);
  assert.doesNotMatch(unkept.all, /agent-browser|recovery failed|not set up/);
});

test('unknown top-level commands fail and suggest the nearest real command', () => {
  const r = runCli(['tabs'], { home });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command 'tabs'/);
  assert.match(r.stderr, /Did you mean 'tab-list'/);
  assert.equal(r.stdout, '');
});

test('the agent-browser proxy uses the packaged dependency instead of PATH', () => {
  const bin = join(home, 'old-agent-browser');
  const fake = join(bin, 'agent-browser');
  mkdirSync(bin, { recursive: true });
  writeFileSync(fake, '#!/bin/sh\nprintf "agent-browser 0.33.2\\n"\n');
  chmodSync(fake, 0o755);

  const r = runCli(['agent-browser', '--version'], {
    home,
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'agent-browser 0.34.0');
});

test('an unbound agent-browser command cannot launch a temporary browser', () => {
  const r = runCli(['agent-browser', '--session', 'unbound', 'open', 'about:blank'], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires a connected lane or an explicit --cdp endpoint/);
});

test('custom commands reject --profile instead of ignoring it or reading it as a URL', () => {
  for (const args of [
    ['--profile', '/some/dir', 'cdp'],
    ['attach', '--profile=/some/dir', 'https://example.com'],
  ]) {
    const r = runCli(args, { home });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--profile is not supported/);
    assert.match(r.stderr, /-s=<name>/);
    assert.doesNotMatch(r.all, /not set up/);
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

test('panel control refuses to signal an unversioned runtime', () => {
  const r = runCli(['-s=not-running', 'panel', 'status'], { home });
  assert.equal(r.code, 1);
  const response = JSON.parse(r.stdout);
  assert.equal(response.error.code, 'RUNTIME_MISMATCH');
  assert.match(response.error.message, /web-plane install/);
});

test('UI status refuses to signal an unversioned runtime', () => {
  const r = runCli(['-s=not-running', 'ui', 'status'], { home });
  assert.equal(r.code, 1);
  const response = JSON.parse(r.stdout);
  assert.equal(response.error.code, 'RUNTIME_MISMATCH');
  assert.match(response.error.message, /web-plane install/);
});

test('close never claims success for a session it could not find', () => {
  const r = runCli(['-s=definitely-not-running', 'close'], { home });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.all, /Closed session/);
});
