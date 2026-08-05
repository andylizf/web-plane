import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync, openSync } from 'fs';
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
 * are all transparent and parked offscreen can still be frontmost. Measured
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
  paths = buildRuntime(home);
});

after(() => {
  if (browser?.pid) killQuietly(browser.pid);
  releaseDisplay?.();
  removeTmpDir(home);
});

test('a hidden launch never takes the foreground', async () => {
  const logPath = join(home, 'focus-launch.jsonl');
  const mon = await startFocusmon(logPath);

  // The observer has to be running *before* the browser starts: the activation
  // under test happens about a second into the launch.
  browser = await launchClone({ paths, session: SESSION });

  // Let the restoration pass run. It fired 1.7-3.2s in when it was firing at
  // all, so a shorter window could pass by finishing early.
  await waitFor(() => Date.now(), () => false, { timeoutMs: 5000, everyMs: 500 });
  mon.kill();

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

test('show brings a parked window back to the screen coordinate space', async () => {
  // hide is two acts — alpha 0 and a move to (-9999,-9999) — and show restored
  // only the alpha for a long time. Chrome's own windows came back anyway
  // because show repositions them over CDP, which hid the gap for everything
  // Chrome manages. It does not manage windows macOS injects into the process,
  // and one of those is Screen Time's lockout panel: it stayed a full screen
  // away while reporting itself visible, so the user saw an unexplained blank
  // and could not click the button on it.
  //
  // Asserted on coordinates rather than on visibility on purpose: whether a
  // window is composited depends on Screen Time, occlusion and the display
  // state, but "no window of this process is parked at -9999 after show" is
  // true or false on its own.
  assert.ok(browser?.pid, 'no browser from the previous test');

  // Deliberately not asserting where hide leaves the window. Parking is done by
  // the cloak hook and the enforcement timer, not by SIGUSR1 (which only sets
  // alpha), so which windows are at -9999 at any moment depends on which of
  // those fired — an implementation detail this test has no business pinning.
  // The contract worth holding is only the one below.
  assert.equal(runCli([`-s=${SESSION}`, 'hide'], { home }).code, 0);
  await waitFor(
    () => contentWindow(probe(probeBin, browser.pid)),
    (w) => w && w.alpha === 0,
    { timeoutMs: 5000 }
  );

  runCli([`-s=${SESSION}`, 'show'], { home });

  // Only real content windows. Chrome parks its own 1x1
  // NativeWidgetMacOverlayNSWindows at -9999 permanently — that is Chrome's
  // doing, not ours, they were never cloaked, and unpark correctly leaves them
  // alone. Asserting over every window would fail on windows the fix must not
  // touch.
  const isContentWindow = (w) => w.w > 100 && w.h > 100;
  const parkedContent = (p) =>
    (p?.windows ?? []).filter(isContentWindow).filter((w) => w.x < -9000);

  const back = await waitFor(
    () => probe(probeBin, browser.pid),
    (p) => p && parkedContent(p).length === 0,
    { timeoutMs: 6000 }
  );
  const stillParked = parkedContent(back.last);
  assert.deepEqual(
    stillParked.map((w) => `#${w.number} ${w.w}x${w.h} at (${w.x},${w.y})`),
    [],
    'show left windows parked offscreen — they report as shown and are a screen away'
  );
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
