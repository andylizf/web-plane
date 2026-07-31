import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';
import { makeRuntime, systemChromeVersion, SYSTEM_CHROME_APP } from '../helpers/fixtures.js';
import { runCli } from '../helpers/cli.js';
import { existsSync } from 'fs';

// `doctor` is the only thing standing between a degraded install and an agent
// that thinks it is stealthy. Its failure mode is not crashing — it is printing
// ticks. So each case here breaks exactly one layer and asks whether doctor
// notices, with a healthy install as the control.

let root;

before(() => {
  assert.equal(process.platform, 'darwin', 'these tests describe macOS behaviour');
  assert.ok(
    existsSync(SYSTEM_CHROME_APP),
    `Google Chrome is not installed at ${SYSTEM_CHROME_APP}; doctor compares the clone against it`
  );
  root = makeTmpDir('doctor');
});

after(() => root && removeTmpDir(root));

/** A fresh fake $HOME with the requested breakage, and doctor's verdict on it. */
function doctorOn(name, opts) {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  makeRuntime(home, opts);
  return runCli(['doctor'], { home });
}

test('a healthy install passes', () => {
  const r = doctorOn('healthy', {});
  assert.equal(r.code, 0, `doctor should pass on a healthy install:\n${r.all}`);
  assert.match(r.stdout, /✓ playwright patch/);
  assert.match(r.stdout, /✓ clone signature/);
  assert.match(r.stdout, /✓ suppression dylib/);
});

test('a reverted playwright patch is caught and named', () => {
  // The patch lives in a third-party node_modules tree, so it can go missing on
  // any reinstall. When it does, launches silently fall back to the *system*
  // Chrome: window visible, no DYLD hook, `hide` can only minimize.
  const r = doctorOn('nopatch', { browserTypePatch: false });
  assert.equal(r.code, 1, `doctor must fail when stealth is off:\n${r.all}`);
  assert.match(r.stdout, /✗ playwright patch/);
  assert.match(r.stdout, /browserType\.js \(marker absent\)/);
  assert.match(r.stdout, /fix: web-plane install/);
});

test('a missing patched file is distinguished from an unpatched one', () => {
  const r = doctorOn('nofile', { crBrowserFile: false });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /crBrowser\.js \(file not found\)/);
});

test('a clone Chrome that is no longer ad-hoc signed is caught', () => {
  // What a background Chrome update does: replaces the binary and re-signs it
  // with Google's certificate, which restores library validation and makes DYLD
  // ignore the dylib. Everything still "works" except the stealth.
  const r = doctorOn('resigned', { clone: 'signed' });
  assert.equal(r.code, 1, `doctor must fail when injection cannot work:\n${r.all}`);
  assert.match(r.stdout, /✗ clone signature/);
  assert.match(r.stdout, /injection will fail/);
});

test('a missing clone is caught', () => {
  const r = doctorOn('noclone', { clone: 'missing' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ clone Chrome/);
  assert.match(r.stdout, /not present/);
});

test('a missing suppression dylib is caught', () => {
  const r = doctorOn('nodylib', { dylib: false });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ suppression dylib/);
  assert.match(r.stdout, /not compiled/);
});

test('version drift is reported as a warning, not a failure', () => {
  // Stealth still works with a stale clone; it is a fingerprinting tell, not a
  // broken install. Reporting it as fatal would train people to ignore doctor.
  const system = systemChromeVersion();
  assert.ok(system, 'could not read the system Chrome version');
  const r = doctorOn('drift', { cloneVersion: '1.0.0' });
  assert.equal(r.code, 0, `drift must not fail the check:\n${r.all}`);
  assert.match(r.stdout, /⚠ clone version/);
  assert.match(r.stdout, new RegExp(`1\\.0\\.0 ≠ system ${system.replace(/\./g, '\\.')}`));
});

test('breaking two layers reports both, not just the first', () => {
  const r = doctorOn('twobroken', { dylib: false, clone: 'missing' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ clone Chrome/);
  assert.match(r.stdout, /✗ suppression dylib/);
});
