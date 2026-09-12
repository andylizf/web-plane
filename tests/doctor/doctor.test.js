import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';
import { makeRuntime, systemChromeVersion, SYSTEM_CHROME_APP } from '../helpers/fixtures.js';
import { runCli } from '../helpers/cli.js';
import { existsSync } from 'fs';
import { RUNTIME_VERSION } from '../../lib/config.js';
import { spawnSync } from 'node:child_process';

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
  assert.match(r.stdout, /applied \(browserType\.js \+ crBrowser\.js \+ chromium\.js \+ crPage\.js\)/);
  assert.match(r.stdout, /✓ runtime protocol/);
  assert.match(r.stdout, /✓ clone signature/);
  assert.match(r.stdout, /✓ suppression dylib/);
  assert.match(r.stdout, /✓ inner profiles\s+Default selected; no splits detected/);
});

test('a legacy inner-profile split is visible while Default remains selected', () => {
  const r = doctorOn('profile-split', { profileSplit: true });
  assert.equal(r.code, 0, `an explicitly selected legacy split should remain usable:\n${r.all}`);
  assert.match(r.stdout, /⚠ inner profiles/);
  assert.match(r.stdout, /legacy-split \(Default, Profile 1\)/);
  assert.match(r.stdout, /Default selected/);
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

test('the old generic patch marker does not pass as the run-id protocol', () => {
  const r = doctorOn('legacy-patch', { browserTypePatch: 'legacy' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /browserType\.js \(marker absent\)/);
});

test('a runtime built for another protocol is rejected', () => {
  const r = doctorOn('old-runtime', { runtimeVersion: '6' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`installed protocol 6 != package protocol ${RUNTIME_VERSION}`));
  assert.match(r.stdout, /fix: web-plane install/);
});

test('the runtime without the WindowServer alpha hook requires a rebuild', () => {
  const r = doctorOn('pre-alpha-hook', { runtimeVersion: '8' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`installed protocol 8 != package protocol ${RUNTIME_VERSION}`));
  assert.match(r.stdout, /fix: web-plane install/);
});

test('an unversioned legacy runtime is rejected', () => {
  const r = doctorOn('unversioned-runtime', { runtimeVersion: null });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /runtime protocol version missing/);
});

test('a missing patched file is distinguished from an unpatched one', () => {
  const r = doctorOn('nofile', { crBrowserFile: false });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /crBrowser\.js \(file not found\)/);
});

test('a runtime that still adds a synthetic startup tab is rejected', () => {
  const r = doctorOn('no-native-restore-patch', { chromiumFile: false });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /chromium\.js \(file not found\)/);
  assert.match(r.stdout, /fix: web-plane install/);
});

test('a runtime whose Playwright still enables focus emulation on every page is rejected', () => {
  const r = doctorOn('no-focus-patch', { crPageFile: false });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /crPage\.js \(file not found\)/);
  assert.match(r.stdout, /fix: web-plane install/);
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

test('a legacy pid-scoped dylib cannot pass beside the run-id patches', () => {
  const r = doctorOn('legacy-dylib', { dylib: 'legacy' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /run-id protocol marker absent/);
});

test('a panel-only dylib cannot pass as the UI-blocker protocol', () => {
  const r = doctorOn('panel-only-dylib', { dylib: 'panel-only' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /native UI-blocker marker absent/);
});

test('a clone behind system Chrome is reported as a warning, not a failure', () => {
  // Stealth still works with a stale clone; it is a fingerprinting tell, not a
  // broken install. Reporting it as fatal would train people to ignore doctor.
  const system = systemChromeVersion();
  assert.ok(system, 'could not read the system Chrome version');
  const r = doctorOn('drift', { cloneVersion: '1.0.0' });
  assert.equal(r.code, 0, `drift must not fail the check:\n${r.all}`);
  assert.match(r.stdout, /⚠ clone version/);
  // The direction has to be in the text: "≠ system" was true of both directions
  // and only one of them is worth acting on.
  assert.match(r.stdout, new RegExp(`1\\.0\\.0 — BEHIND system ${system.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /fix: web-plane install/);
});

test('launch preflight allows version drift while warning about it', () => {
  const r = preflightOn('preflight-drift', { cloneVersion: '1.0.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /lags system Chrome/);
  assert.match(r.stderr, /Stealth still works/);
});

for (const [name, opts] of [
  ['runtime protocol mismatch', { runtimeVersion: '6' }],
  ['missing Playwright patch', { browserTypePatch: false }],
  ['missing clone', { clone: 'missing' }],
  ['non-injectable clone', { clone: 'signed' }],
  ['missing suppression dylib', { dylib: false }],
  ['incompatible suppression dylib', { dylib: 'legacy' }],
]) {
  test(`launch preflight still rejects ${name} when the clone version lags`, () => {
    const r = preflightOn(`preflight-${name}`, { cloneVersion: '1.0.0', ...opts });
    assert.equal(r.status, 1, r.stderr);
  });
}

function preflightOn(name, opts) {
  const runtime = makeRuntime(join(root, name), opts);
  return spawnSync(process.execPath, [
    '--input-type=module', '--eval',
    `import { warnIfDegraded } from ${JSON.stringify(new URL('../../lib/health.js', import.meta.url).href)};
     process.exitCode = warnIfDegraded() ? 0 : 1;`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, WEB_PLANE_RUNTIME_DIR: runtime },
  });
}

test('a clone AHEAD of system Chrome is not a defect and prescribes nothing', () => {
  // What a self-updating clone leaves behind, and the false alarm that started
  // this: doctor said `⚠ 151.0.7922.76 ≠ system 150.0.7871.189, fix: web-plane
  // install`, install said `==> Chrome clone up to date`, and the loop repeated.
  // Chrome's updater writes a new framework into whichever bundle it is running
  // from, so the clone runs ahead of the system Chrome on its own; re-cloning
  // would downgrade it.
  const system = systemChromeVersion();
  assert.ok(system, 'could not read the system Chrome version');
  const r = doctorOn('ahead', { cloneVersion: '999.0.0' });
  assert.equal(r.code, 0, `a clone ahead of system Chrome must not fail the check:\n${r.all}`);
  assert.match(r.stdout, /✓ clone version/);
  assert.match(r.stdout, new RegExp(`999\\.0\\.0 — ahead of system ${system.replace(/\./g, '\\.')}`));
  // The whole point: no fix is offered, because install would decline to act.
  const versionLine = r.stdout.split('\n').findIndex((l) => /clone version/.test(l));
  assert.doesNotMatch(
    r.stdout.split('\n')[versionLine + 1] ?? '',
    /fix:/,
    'doctor must not prescribe a fix its own installer treats as a no-op'
  );
});

test('doctor and install agree about whether the clone needs re-cloning', () => {
  // Not a wording test: the two commands answer from one function now, and this
  // is the assertion that keeps them there. doctor's row is a ⚠ with a fix if and
  // only if cloneRefresh().needed, which is the branch install takes.
  const system = systemChromeVersion();
  for (const [name, version, needed] of [
    ['agree-behind', '1.0.0', true],
    ['agree-ahead', '999.0.0', false],
    ['agree-match', system, false],
  ]) {
    const r = doctorOn(name, { cloneVersion: version });
    const warned = /⚠ clone version/.test(r.stdout);
    assert.equal(
      warned,
      needed,
      `clone ${version} vs system ${system}: doctor ${warned ? 'warns' : 'does not warn'} but ` +
        `install would ${needed ? '' : 'not '}re-clone:\n${r.all}`
    );
  }
});

test('breaking two layers reports both, not just the first', () => {
  const r = doctorOn('twobroken', { dylib: false, clone: 'missing' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ clone Chrome/);
  assert.match(r.stdout, /✗ suppression dylib/);
});
