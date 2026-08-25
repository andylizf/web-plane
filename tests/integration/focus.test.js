import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, openSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';
import { runCli } from '../helpers/cli.js';
import {
  buildProbe,
  buildRuntime,
  contentWindow,
  isAlive,
  keepDisplayAwake,
  killQuietly,
  launchClone,
  probe,
  requireLiveDisplay,
  requireMacGui,
  waitFor,
} from '../helpers/browser.js';

/**
 * Launching a hidden session must not take the user's keyboard.
 *
 * This is a separate axis from every other window test in this suite, and
 * conflating the two is what let the bug live for so long: macOS grants the
 * foreground to an *application*, not to a window, so a browser whose windows
 * are all transparent can still be frontmost. Measured
 * before the fix: six seconds of stolen focus with no window ever visible.
 *
 * The activation does not come from Chromium. It is AppKit's own window
 * restoration pass, which activates the app from a completion handler through a
 * private funnel that no public API sits on — see docs/window-and-focus.md.
 *
 * Two things make these assertions trustworthy, both learned by being fooled:
 *
 *   Focus is observed by events, not sampling. An activation that grabs the
 *   front and hands it back within a frame is invisible to any poll slower than
 *   the grab, and that is exactly the grab a user feels.
 *
 *   Liveness is part of the verdict. A browser that never started never takes
 *   focus, so a dead browser produces a perfectly clean log — an early patch
 *   that killed Chrome outright "passed" three times in a row.
 */

const SESSION = 'focustest';

let home;
let paths;
let probeBin;
let focusmonBin;
let focusHostApp;
let focusHost;
let focusMonitor;
let browser;
let releaseDisplay;

function buildFocusmon(dir) {
  const out = join(dir, 'focusmon');
  execFileSync('cc', [
    '-Wall', '-Werror',
    '-framework', 'AppKit',
    '-framework', 'Foundation',
    '-o', out,
    join(REPO_ROOT, 'tests', 'native', 'focusmon.m'),
  ]);
  return out;
}

function buildFocusHost(dir) {
  const app = join(dir, 'FocusHost.app');
  const macos = join(app, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>' +
      '<key>CFBundleIdentifier</key><string>dev.web-plane.FocusHost</string>' +
      '<key>CFBundleExecutable</key><string>FocusHost</string>' +
      '<key>CFBundlePackageType</key><string>APPL</string>' +
      '<key>LSBackgroundOnly</key><false/>' +
      '</dict></plist>\n'
  );
  execFileSync('cc', [
    '-Wall', '-Werror',
    '-framework', 'AppKit',
    '-framework', 'Foundation',
    '-o', join(macos, 'FocusHost'),
    join(REPO_ROOT, 'tests', 'native', 'focus_host.m'),
  ]);
  return app;
}

/** Start the observer and wait until it has written its baseline line. */
async function startFocusmon(logPath) {
  const fd = openSync(logPath, 'w');
  const proc = spawn(focusmonBin, [], { stdio: ['ignore', fd, 'ignore'] });
  const ready = await waitFor(
    () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
    (text) => text.includes('"event":"baseline"'),
    { timeoutMs: 5000, everyMs: 50 }
  );
  assert.ok(ready.ok, 'focusmon never wrote a baseline; it cannot observe anything');
  return proc;
}

/**
 * Activations belonging to one pid.
 *
 * Filtered by pid rather than by app name because the observer is machine-wide:
 * it sees the user's own Chrome, and — when suites run side by side — the
 * browser another test file launched. Matching on the name alone attributed
 * those to this test and failed it for someone else's window. The suite is now
 * serial as well (`--test-concurrency=1`, since these tests own the screen), but
 * the pid filter is what makes the assertion correct rather than merely lucky.
 */
function chromeActivations(logPath, pid) {
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map((l) => JSON.parse(l))
    .filter((e) => (e.event === 'activate' || e.event === 'poll-front') && e.pid === pid);
}

before(async () => {
  requireMacGui();
  home = makeTmpDir('focus-home');
  releaseDisplay = keepDisplayAwake();
  probeBin = buildProbe(home);
  await requireLiveDisplay(probeBin);
  focusmonBin = buildFocusmon(home);
  focusHostApp = buildFocusHost(home);
  paths = buildRuntime(home);
});

after(() => {
  if (browser?.pid) killQuietly(browser.pid);
  if (focusHost?.pid) killQuietly(focusHost.pid);
  if (focusMonitor?.pid) killQuietly(focusMonitor.pid);
  releaseDisplay?.();
  removeTmpDir(home);
});

test('a hidden launch never takes the foreground', async () => {
  const logPath = join(home, 'focus-launch.jsonl');
  focusMonitor = await startFocusmon(logPath);

  // Establish a foreground app that can actually lose focus. loginwindow is a
  // common baseline on unattended Macs and makes the no-activation assertion
  // pass even when the activation gate is removed.
  const focusHostBin = join(focusHostApp, 'Contents', 'MacOS', 'FocusHost');
  execFileSync('/usr/bin/open', ['-n', focusHostApp]);
  const hostStarted = await waitFor(
    () => {
      try {
        return Number(execFileSync('pgrep', ['-f', focusHostBin], { encoding: 'utf8' }).trim().split('\n')[0]);
      } catch {
        return null;
      }
    },
    (pid) => Number.isInteger(pid) && pid > 1,
    { timeoutMs: 5000, everyMs: 50 }
  );
  assert.ok(hostStarted.ok, 'LaunchServices did not start the focus sentinel app');
  focusHost = { pid: hostStarted.last };
  const sentinel = await waitFor(
    () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    (events) => events.some(
      (event) => (event.event === 'activate' || event.event === 'poll-front') &&
        event.pid === focusHost.pid
    ),
    { timeoutMs: 5000, everyMs: 50 }
  );
  assert.ok(sentinel.ok, 'the focus sentinel never became frontmost; focus theft cannot be tested');

  // The observer has to be running *before* the browser starts: the activation
  // under test happens about a second into the launch.
  browser = await launchClone({ paths, session: SESSION });

  // Let the restoration pass run. It fired 1.7-3.2s in when it was firing at
  // all, so a shorter window could pass by finishing early.
  await waitFor(() => Date.now(), () => false, { timeoutMs: 5000, everyMs: 500 });
  focusMonitor.kill();
  focusMonitor = null;

  assert.ok(
    isAlive(browser.pid),
    'the browser is not running, so a clean focus log proves nothing'
  );

  const stolen = chromeActivations(logPath, browser.pid);
  assert.deepEqual(
    stolen.map((e) => `${e.t} ${e.app} (policy=${e.policy})`),
    [],
    'the clone became frontmost during a hidden launch'
  );
});

test('hide never changes a browser frame coordinate', async () => {
  // Native sheets inherit their position from the browser frame. The old
  // offscreen parking moved both the invisible browser and a visible Save panel
  // away from every display; macOS also clamped the frame and left a transparent
  // click target behind. Hiding must now be alpha/click-through only.
  assert.ok(browser?.pid, 'no browser from the previous test');
  const before = contentWindow(probe(probeBin, browser.pid));
  assert.ok(before, 'no content window existed before hide');

  assert.equal(runCli([`-s=${SESSION}`, 'hide'], { home }).code, 0);
  const hidden = await waitFor(
    () => contentWindow(probe(probeBin, browser.pid)),
    (w) => w && w.alpha === 0 && w.x === before.x && w.y === before.y,
    { timeoutMs: 5000 }
  );
  assert.ok(
    hidden.ok,
    `hide changed browser geometry: before=${JSON.stringify(before)} ` +
      `after=${JSON.stringify(hidden.last)}`
  );

  runCli([`-s=${SESSION}`, 'show'], { home });
});

test('the private activation selector the fix depends on still exists', () => {
  // The focus fix swizzles -[NSApplication _activateWithInfo:]. It is private,
  // so an OS update can rename or reshape it; the dylib then declines to install
  // the hook and silently falls back to handing focus back after the fact, which
  // degrades from zero stolen focus to a visible blink. Failing here turns that
  // into a build-time warning instead of a bug report.
  const bin = join(home, 'selcheck');
  execFileSync('cc', [
    '-Wall', '-Werror',
    '-framework', 'AppKit',
    '-framework', 'Foundation',
    '-o', bin,
    join(REPO_ROOT, 'tests', 'native', 'selcheck.m'),
  ]);
  const out = execFileSync(bin, { encoding: 'utf8' });
  assert.match(out, /all activation hook targets intact/, out);
});
