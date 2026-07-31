import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindow, screenWindowAt, isParked } from '../../lib/window.js';

// The verifier is the thing that decides whether `show` tells the truth, and it
// is fed by two sources that routinely disagree: `cur` is what Chrome believes
// (CDP bounds) and `screen` is what the window server reports. Each disagreement
// below has been a real, silently-successful failure at some point.

const PID = 4242;

/** What the window server reports for one window of ours. */
function serverWindow(over = {}) {
  return { alpha: 1, left: 100, top: 100, width: 1280, height: 800, onScreenCount: 1, ...over };
}

/** What Chrome reports for the same window. */
function chromeBounds(over = {}) {
  return { left: 100, top: 100, width: 1280, height: 800, windowState: 'normal', ...over };
}

// Chrome keeps a crowd of these around; they are why the content window can only
// be picked out by geometry.
const NOISE = [
  { alpha: 1, left: 0, top: 0, width: 1, height: 1, onScreenCount: 1 },
  { alpha: 1, left: 0, top: 0, width: 1512, height: 33, onScreenCount: 1 },
];

test('a genuinely visible window reports no problem', () => {
  assert.equal(classifyWindow(1, chromeBounds(), [...NOISE, serverWindow()], PID), null);
});

test('a miniaturized window is caught even though every other signal looks right', () => {
  // This is the exact shape of the bug that `show` used to print "Window shown"
  // over: Chrome says normal (it never saw the minimize — the dylib did it
  // behind its back), and the window server still reports alpha 1 at the right
  // bounds, because a miniaturized window keeps both. Only its absence from the
  // on-screen list gives it away.
  const problem = classifyWindow(
    1,
    chromeBounds(),
    [...NOISE, serverWindow({ alpha: 1, onScreenCount: 0 })],
    PID
  );
  assert.ok(problem, 'expected a problem for a window in the Dock');
  assert.match(problem, /miniaturized/);
  assert.match(problem, /Dock/);
});

test('an opaque-looking window that is actually transparent is caught', () => {
  const problem = classifyWindow(1, chromeBounds(), [serverWindow({ alpha: 0 })], PID);
  assert.match(problem, /fully transparent/);
});

test('a window still parked offscreen is caught before the alpha check', () => {
  const problem = classifyWindow(1, chromeBounds({ left: -9999, top: -9999 }), null, PID);
  assert.match(problem, /parked offscreen at \(-9999, -9999\)/);
});

test("Chrome's own 'minimized' state is reported as such", () => {
  const problem = classifyWindow(1, chromeBounds({ windowState: 'minimized' }), [serverWindow()], PID);
  assert.match(problem, /still minimized/);
});

test('a window Chrome will not describe is a problem, not a pass', () => {
  assert.match(classifyWindow(1, undefined, [serverWindow()], PID), /would not report its bounds/);
});

test('bounds Chrome believes but the window server has never heard of are caught', () => {
  // Seen when the injected hook drifts out of sync with its flag files: Chrome's
  // bookkeeping says the window is at (100,100), the compositor has nothing there.
  const problem = classifyWindow(1, chromeBounds(), NOISE, PID);
  assert.match(problem, /window server has no window of that size there/);
});

test('an unanswerable window-server query is not treated as proof of visibility', () => {
  // screen === null means the query failed (no BridgeSupport, osascript refused).
  // Returning "no problem" here is only safe because the caller then tells the
  // user the alpha half went unchecked.
  assert.equal(classifyWindow(1, chromeBounds(), null, PID), null);
});

test('placement is matched with tolerance, because macOS rounds and clamps', () => {
  const nudged = [serverWindow({ left: 104, top: 96, width: 1274 })];
  assert.equal(classifyWindow(1, chromeBounds(), nudged, PID), null);

  const elsewhere = [serverWindow({ left: 400 })];
  assert.match(classifyWindow(1, chromeBounds(), elsewhere, PID), /no window of that size/);
});

test('the content window is picked by size, not by being first', () => {
  const list = [...NOISE, serverWindow({ alpha: 0.5 })];
  assert.equal(screenWindowAt(list, chromeBounds()).width, 1280);
  // A window too small to be the one the user is meant to see is not a match.
  assert.equal(screenWindowAt([{ alpha: 1, left: 100, top: 100, width: 399, height: 800 }], chromeBounds()), null);
});

test('parked means at most a sliver is left on screen', () => {
  assert.equal(isParked({ left: -9999, width: 1280 }), true);
  assert.equal(isParked({ left: -1180, width: 1280 }), true, 'exactly at the sliver limit');
  assert.equal(isParked({ left: 100, width: 1280 }), false);
  // macOS refuses to push a window fully off, so a "hidden" window can sit with
  // ~40px still inside the display — that must still count as parked.
  assert.equal(isParked({ left: -1240, width: 1280 }), true);
});
