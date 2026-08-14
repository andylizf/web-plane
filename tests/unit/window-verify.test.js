import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWindow,
  compositorBlindSpot,
  isParked,
  measuredWindowState,
  screenWindowAt,
} from '../../lib/window.js';

// The verifier is the thing that decides whether `show` tells the truth, and it
// is fed by two sources that routinely disagree: `cur` is what Chrome believes
// (CDP bounds) and `screen` is what the window server reports. Each disagreement
// below has been a real, silently-successful failure at some point.

const PID = 4242;

/** What the window server reports for one window of ours. */
function serverWindow(over = {}) {
  return { number: 900, alpha: 1, left: 100, top: 100, width: 1280, height: 800, onScreen: true, ...over };
}

/**
 * A whole window-server reading: this pid's windows plus the two scope-wide
 * facts that say whether the compositor is in a state worth believing.
 * `systemOnScreen` defaults high because most of these cases are about one
 * window being wrong on a machine that is otherwise drawing normally.
 */
function serverState(windows, over = {}) {
  return { windows, systemOnScreen: 12, screenLocked: false, ...over };
}

/** What Chrome reports for the same window. */
function chromeBounds(over = {}) {
  return { left: 100, top: 100, width: 1280, height: 800, windowState: 'normal', ...over };
}

// Chrome keeps a crowd of these around; they are why the content window can only
// be picked out by geometry.
const NOISE = [
  { number: 901, alpha: 1, left: 0, top: 0, width: 1, height: 1, onScreen: true },
  { number: 902, alpha: 1, left: 0, top: 0, width: 1512, height: 33, onScreen: true },
];

test('a genuinely visible window reports no problem', () => {
  assert.equal(classifyWindow(1, chromeBounds(), serverState([...NOISE, serverWindow()]), PID), null);
});

test('status reports visibility from the window server', () => {
  const wins = [{ windowId: 1, bounds: chromeBounds() }];
  assert.equal(measuredWindowState(wins, serverState([...NOISE, serverWindow()])), 'visible');
  assert.equal(
    measuredWindowState(
      wins,
      serverState([...NOISE, serverWindow({ alpha: 0, left: -9999, top: -9999, onScreen: false })])
    ),
    'hidden'
  );
});

test('status says unknown when the window server cannot support a verdict', () => {
  const wins = [{ windowId: 1, bounds: chromeBounds() }];
  assert.equal(measuredWindowState(wins, null), 'unknown');
  assert.equal(
    measuredWindowState(wins, serverState([serverWindow({ onScreen: false })])),
    'unknown',
    'off-screen with normal Chrome bounds can also mean another Space'
  );
});

test('status calls a window minimized only when Chrome and the window server agree', () => {
  const wins = [{ windowId: 1, bounds: chromeBounds({ windowState: 'minimized' }) }];
  assert.equal(
    measuredWindowState(wins, serverState([serverWindow({ onScreen: false })])),
    'minimized'
  );
  assert.equal(measuredWindowState(wins, serverState([serverWindow()])), 'visible');
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
    serverState([...NOISE, serverWindow({ alpha: 1, onScreen: false })]),
    PID
  );
  assert.ok(problem, 'expected a problem for a window in the Dock');
  assert.match(problem, /miniaturized/);
  assert.match(problem, /Dock/);
});

test('a window in the Dock is caught even while a sibling window is on screen', () => {
  // On-screen-ness used to be counted per pid, so this window passed on the
  // strength of its sibling: any browser with a popup open had a minimized
  // window read as visible. It is membership in the on-screen list, per window.
  const sibling = serverWindow({ number: 903, left: 900, top: 900, onScreen: true });
  const problem = classifyWindow(
    1,
    chromeBounds(),
    serverState([...NOISE, serverWindow({ onScreen: false }), sibling]),
    PID
  );
  assert.match(problem, /miniaturized/);
});

test('an opaque-looking window that is actually transparent is caught', () => {
  const problem = classifyWindow(1, chromeBounds(), serverState([serverWindow({ alpha: 0 })]), PID);
  assert.match(problem, /fully transparent/);
});

test('a window still parked offscreen is caught before the alpha check', () => {
  const problem = classifyWindow(1, chromeBounds({ left: -9999, top: -9999 }), null, PID);
  assert.match(problem, /parked offscreen at \(-9999, -9999\)/);
});

test("Chrome's own 'minimized' state is reported as such", () => {
  const problem = classifyWindow(1, chromeBounds({ windowState: 'minimized' }), serverState([serverWindow()]), PID);
  assert.match(problem, /still minimized/);
});

test('a window Chrome will not describe is a problem, not a pass', () => {
  assert.match(classifyWindow(1, undefined, serverState([serverWindow()]), PID), /would not report its bounds/);
});

test('bounds Chrome believes but the window server has never heard of are caught', () => {
  // Seen when the injected hook drifts out of sync with its flag files: Chrome's
  // bookkeeping says the window is at (100,100), the compositor has nothing there.
  const problem = classifyWindow(1, chromeBounds(), serverState(NOISE), PID);
  assert.match(problem, /window server has no window of that size there/);
});

test('an unanswerable window-server query is not treated as proof of visibility', () => {
  // screen === null means the query failed (no BridgeSupport, osascript refused).
  // Returning "no problem" here is only safe because the caller then tells the
  // user the alpha half went unchecked.
  assert.equal(classifyWindow(1, chromeBounds(), null, PID), null);
});

// --- The compositor's own state, which the checks above all quietly assume ----
//
// The state staged here is a sleeping display: on 2026-08-10 it made `show` print
// "NOT verifiably visible ... miniaturized — it is in the Dock's minimized tray"
// three times in four minutes, over a window that was on screen the whole time,
// and the reader believed it and went off repairing a working browser. The
// window server had simply stopped compositing, which empties
// kCGWindowListOptionOnScreenOnly for every application at once — so a window's
// absence from that list says nothing about the window until it is known that
// something, anything, is being drawn.

/** The window server while the display sleeps: our window absent, and so is everyone's. */
function asleep(windows) {
  return serverState(windows, { systemOnScreen: 0 });
}

test('a sleeping display is not evidence that our window is in the Dock', () => {
  const state = asleep([...NOISE.map((w) => ({ ...w, onScreen: false })), serverWindow({ onScreen: false })]);
  assert.equal(
    classifyWindow(1, chromeBounds(), state, PID),
    null,
    'a window absent from an empty on-screen list must not be called miniaturized'
  );
});

test('a sleeping display is reported as inconclusive rather than passed over', () => {
  // The other half of the same fix: returning "no problem" is only honest because
  // the caller says the window server went unconsulted and why. If this ever
  // returns null, `show` prints a bare "Window shown" it cannot back up.
  const reason = compositorBlindSpot(asleep([serverWindow({ onScreen: false })]));
  assert.ok(reason, 'a display-asleep reading must name itself');
  assert.match(reason, /asleep/);
  assert.doesNotMatch(reason, /miniaturized|Dock/, 'it must not diagnose the window');
});

test('a locked screen is inconclusive too, though other windows are composited', () => {
  // Not covered by the count, and the numbers here are measured rather than
  // guessed: sampled across a real lock on 2026-08-10 (17:21:55-17:22:56 local,
  // tests/tools/probe-display-sleep.mjs) the machine-wide count went UP, from
  // 11-12 unlocked to 41-42 locked, because the lock screen composites a crowd of
  // its own windows while every application window reads as off-screen. Hence 42
  // below: a locked screen never trips the count, so `screenLocked` is the only
  // thing standing between this state and a false "miniaturized".
  const state = serverState([serverWindow({ onScreen: false })], {
    systemOnScreen: 42,
    screenLocked: true,
  });
  assert.equal(classifyWindow(1, chromeBounds(), state, PID), null);
  assert.match(compositorBlindSpot(state), /locked/);
});

test('a compositor that is drawing normally has no blind spot to hide behind', () => {
  // The escape hatch above must stay shut in the normal case, or the
  // miniaturized-window detection is dead code.
  assert.equal(compositorBlindSpot(serverState([serverWindow()])), null);
  // An unreadable lock flag is not a blind spot either: null means "not known to
  // be locked", and guessing locked would silence the check on every machine
  // where CGSessionCopyCurrentDictionary stops resolving.
  assert.equal(compositorBlindSpot(serverState([serverWindow()], { screenLocked: null })), null);
  // No query at all is the caller's business, not a blind spot.
  assert.equal(compositorBlindSpot(null), null);
});

test('what Chrome itself reports is still judged while the display sleeps', () => {
  // The blind spot excuses the window server, not `show`. These two problems come
  // from CDP, which keeps answering with the display off, so suppressing them
  // would hide the failures `show` is actually able to detect.
  const state = asleep([serverWindow({ onScreen: false })]);
  assert.match(
    classifyWindow(1, chromeBounds({ left: -9999, top: -9999 }), state, PID),
    /parked offscreen/
  );
  assert.match(
    classifyWindow(1, chromeBounds({ windowState: 'minimized' }), state, PID),
    /still minimized/
  );
});

test('alpha is left unjudged while nothing is being composited', () => {
  // Deliberate, and the reason it is a test: whether kCGWindowAlpha stays
  // truthful while the compositor is idle has never been measured on a sleeping
  // display, and the alternative to skipping it is trading a false "miniaturized"
  // for a false "fully transparent". The caller says the check was skipped.
  const state = asleep([serverWindow({ alpha: 0, onScreen: false })]);
  assert.equal(classifyWindow(1, chromeBounds(), state, PID), null);
  // With the compositor awake, alpha 0 is still a defect.
  assert.match(
    classifyWindow(1, chromeBounds(), serverState([serverWindow({ alpha: 0 })]), PID),
    /fully transparent/
  );
});

test('placement is matched with tolerance, because macOS rounds and clamps', () => {
  const nudged = serverState([serverWindow({ left: 104, top: 96, width: 1274 })]);
  assert.equal(classifyWindow(1, chromeBounds(), nudged, PID), null);

  const elsewhere = serverState([serverWindow({ left: 400 })]);
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
