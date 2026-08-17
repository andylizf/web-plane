import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

let dir;
let dylib;
let host;
let runDir;

before(() => {
  dir = makeTmpDir('window-scope');
  dylib = join(dir, 'window_suppress.dylib');
  host = join(dir, 'window_scope_host');
  runDir = join(dir, 'run');
  mkdirSync(runDir, { mode: 0o700 });
  execFileSync('cc', [
    '-Wall',
    '-Werror',
    '-dynamiclib',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    dylib,
    join(REPO_ROOT, 'native', 'window_suppress.m'),
    join(REPO_ROOT, 'native', 'panel_control.m'),
  ]);
  execFileSync('cc', [
    '-Wall',
    '-Werror',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    host,
    join(REPO_ROOT, 'tests', 'native', 'window_scope_host.m'),
  ]);
  execFileSync('codesign', ['--force', '--sign', '-', host], { stdio: 'ignore' });
});

after(() => dir && removeTmpDir(dir));

test('hidden state defers native UI without moving browser frames or attached sheets', () => {
  // This suite deliberately owns the foreground. Establish a normal baseline
  // first: Notification Center can be the frontmost process while a notification
  // stack is open and refuses ordinary application activation, which makes the
  // human-panel assertion describe that external modal state instead of this
  // dylib. Finder activation is reversible and gives the host a real app to hand
  // focus back to after its panel closes.
  execFileSync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.finder").firstObject; if (!a.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)) throw new Error("Finder did not activate")',
  ]);
  execFileSync('/bin/sleep', ['0.2']);
  const result = spawnSync(host, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: dylib,
      WEB_PLANE_RUN_ID: '77953b53-c945-4db6-b02c-d599a0928702',
      WEB_PLANE_RUN_DIR: runDir,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.browserAlpha, 0);
  assert.equal(observed.browserX, 120, 'hiding changed the browser frame geometry');
  assert.equal(observed.browserIgnoresMouse, true);
  assert.equal(observed.panelAlpha, 0);
  assert.equal(observed.panelIgnoresMouse, true);
  assert.ok(observed.panelX + 520 > 100, `panel moved offscreen to x=${observed.panelX}`);
  assert.equal(observed.sheetAlpha, 0);
  assert.equal(observed.sheetIgnoresMouse, true);
  assert.equal(observed.sheetVisible, true);
  assert.equal(observed.panelOnScreen, true, 'native panel was absent from WindowServer');
  assert.equal(observed.sheetOnScreen, true, 'native sheet was absent from WindowServer');
  assert.ok(
    observed.sheetX >= 120 && observed.sheetX < 1020,
    `sheet did not stay attached to the browser frame: x=${observed.sheetX}`
  );
  assert.equal(observed.humanUIActive, false, 'native UI took focus before an explicit show');
  assert.equal(observed.activeAfterClose, false, 'focus suppression was not re-armed after native UI closed');
  assert.equal(observed.recoverAlpha, 0, 'Chrome Recover UI was visible while the browser was hidden');
  assert.equal(observed.recoverIgnoresMouse, true, 'hidden Chrome Recover UI kept a live hit region');
  assert.equal(observed.activeAfterRecover, false, 'Chrome Recover UI re-activated the hidden browser');
  assert.equal(observed.browserAlphaAfterShow, 1);
  assert.equal(observed.browserIgnoresMouseAfterShow, false, 'show left the browser click-through');
  assert.equal(observed.recoverAlphaAfterShow, 1, 'show did not restore Chrome Recover UI');
  assert.equal(observed.recoverIgnoresMouseAfterShow, false, 'show left Chrome Recover UI click-through');
});

test('the show signal recovers a minimized browser without Accessibility permission', () => {
  const result = spawnSync(host, ['minimize'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: dylib,
      WEB_PLANE_RUN_ID: '8f0a5322-a6bc-41b0-9f5f-6c20e48c424f',
      WEB_PLANE_RUN_DIR: runDir,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.minimizedBeforeShow, true, 'the host did not stage a minimized window');
  assert.equal(observed.minimizedAfterShow, false, 'SIGUSR2 left the browser in the Dock');
});
