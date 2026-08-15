import { execSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { paths } from './config.js';
import { findChrome } from './procs.js';

// Raise the app. The window is created while the suppression hook blocks
// orderFront/activate, so it sits at the very back of the z-order; restoring
// bounds and alpha alone leaves it buried under every other window.
function activateApp(pid) {
  const jxa = [
    'ObjC.import("AppKit")',
    `var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})`,
    'app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)',
  ].join('; ');
  execSync(`osascript -l JavaScript -e '${jxa}'`, { stdio: 'ignore' });
}

async function cdpSend(ws, method, params) {
  return new Promise((resolve) => {
    const id = (Math.random() * 1e9) | 0;
    ws.addEventListener('message', function handler(e) {
      const d = JSON.parse(e.data);
      if (d.id === id) {
        ws.removeEventListener('message', handler);
        resolve(d.result || d.error);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForNormal(ws, windowId) {
  for (let tries = 0; tries < 20; tries++) {
    const cur = await cdpSend(ws, 'Browser.getWindowBounds', { windowId });
    if (cur.bounds?.windowState === 'normal') return;
    await sleep(100);
  }
}

// Set bounds and verify the window actually complied. Fresh sessions can come
// up with Chrome's internal window state desynced from AppKit (the launch-time
// miniaturize races the suppress-file cleanup), and a desynced window silently
// ignores every bounds command. A minimized→normal round-trip forces the two
// back into agreement, after which sets work again.
// `isApplied(cur)` can override the ordinary exact-position check for callers
// that need to recognize a legacy offscreen state.
async function setBoundsVerified(ws, windowId, bounds, isApplied) {
  const ok = isApplied ?? ((cur) => cur.left === bounds.left && cur.top === bounds.top);
  for (let attempt = 0; attempt < 2; attempt++) {
    await cdpSend(ws, 'Browser.setWindowBounds', { windowId, bounds });
    await sleep(150);
    const cur = await cdpSend(ws, 'Browser.getWindowBounds', { windowId });
    if (cur.bounds && ok(cur.bounds)) return true;
    if (attempt === 0) {
      await cdpSend(ws, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await sleep(400);
      await cdpSend(ws, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await waitForNormal(ws, windowId);
    }
  }
  return false;
}

// Detect windows left behind by older runtimes that parked them offscreen.
// Current hiding never changes window geometry.
export const isParked = (cur) => cur.left + cur.width <= 100;

// Standing-hidden flag read by the dylib hooks: while it exists, any window
// that orders front is immediately cloaked (alpha 0 + click-through), so
// popups born while hidden never reach the screen. The hooks let the original
// orderFront run first — Chrome's window bookkeeping must stay truthful, or it
// starts ignoring CDP bounds commands entirely. (Do NOT re-arm the launch-time
// suppress file for this: its miniaturize-instead-of-orderFront trick is only
// safe before the first window exists.)
function hiddenFlagFor(chrome) {
  return chrome.runId ? join(paths.runDir, `.chrome-hidden-${chrome.runId}`) : null;
}

function isAlphaHidden(chrome) {
  const flag = hiddenFlagFor(chrome);
  return flag ? existsSync(flag) : false;
}

// The window server's own record of a pid's windows: where each one really is
// and what alpha is actually being composited. Needed because both halves of
// `show` only report on themselves and both can be wrong — CDP returns the
// bounds Chrome *believes* it has, and SIGUSR2 sets NSWindow.alphaValue, which
// is one layer above the alpha that reaches the screen. This is the only view
// that can contradict them.
//
// Returns `{ windows, systemOnScreen, screenLocked }`, or null if the query
// could not be made at all. The two scope-wide fields are what tell an
// individual window's `onScreen: false` apart from "nothing anywhere is on
// screen" — see compositorBlindSpot.
//
// kCGWindowName is deliberately never read: it is the one field in this
// dictionary that requires Screen Recording permission, and no title is needed
// to answer "is it visible".
export function screenWindows(pid) {
  const jxa = [
    'ObjC.import("CoreGraphics")',
    'var all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))',
    `var mine = all.filter(function (w) { return w.kCGWindowOwnerPID === ${pid} })`,
    // onScreen is the ONLY one of these that notices a miniaturized window.
    // Alpha and bounds both survive miniaturization untouched, and Chrome's own
    // windowState says 'normal' because the minimize came from our hook rather
    // than from Chrome — so a window sitting in the Dock's minimized tray passed
    // every check and 'Window shown' was printed over it.
    'var onScreen = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)))',
    // Matched per window by kCGWindowNumber, not counted per pid: a pid-wide
    // count says yes for a window in the Dock as long as any *sibling* window is
    // on screen, which is a live browser with a popup open.
    'var live = {}; onScreen.forEach(function (w) { live[w.kCGWindowNumber] = true })',
    // Whether the screen is locked. Its own try/catch because
    // CGSessionCopyCurrentDictionary is resolved dynamically (no BridgeSupport
    // signature): if it ever stops resolving, that must cost this one field and
    // not the whole query. The key is absent, not false, when unlocked.
    'var locked = null; try { var s = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())); if (s) locked = Boolean(s.CGSSessionScreenIsLocked) } catch (e) {}',
    'JSON.stringify({ systemOnScreen: onScreen.length, screenLocked: locked, windows: mine.map(function (w) { return { number: w.kCGWindowNumber, alpha: w.kCGWindowAlpha, left: w.kCGWindowBounds.X, top: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height, onScreen: Boolean(live[w.kCGWindowNumber]) } }) })',
  ].join('; ');
  try {
    return JSON.parse(
      execSync(`osascript -l JavaScript -e '${jxa}'`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
  } catch {
    // No BridgeSupport, osascript refused, or the process died mid-read.
    // Verification degrades to the bounds check rather than blocking `show`.
    return null;
  }
}

/**
 * Why the window server's answers about what is composited cannot be trusted
 * right now — a short phrase for the user — or null when they can.
 *
 * `kCGWindowListOptionOnScreenOnly` describes the compositor, not the windows:
 * while the display sleeps the compositor draws nothing, so that list is empty
 * for EVERY application and each individual window's `onScreen` is false no
 * matter how correctly it was shown. A locked screen does the same to application
 * windows. Read as a fact about one window, either state accuses a perfectly
 * visible window of sitting in the Dock; that is the false positive this function
 * exists to prevent (three of them in four minutes on 2026-08-10, all inside one
 * display-off interval, while the window was on screen the whole time).
 *
 * The machine-wide count is the discriminator rather than CGDisplayIsAsleep
 * because it comes from the query already being made, needs no second API, and
 * can be staged in a unit test.
 *
 * `screenLocked` is not redundant with it, and the reason is measured rather than
 * assumed. Sampling this query across a real lock (tests/tools/probe-display-sleep.mjs,
 * 2026-08-10 17:21:55-17:22:56 local) the machine-wide count went UP, 11-12 while
 * unlocked to 41-42 while locked: the lock screen composites a crowd of its own
 * windows. So a locked screen never trips the count, and dropping this line
 * because "locking must empty the list too" would restore the false positive on
 * every locked Mac.
 *
 * The count's own phrasing stops short of naming the cause, because a sleeping
 * display is not the only way to empty that list: docs/window-and-focus.md
 * records that a fullscreen app on another Space reads the same way. Both are
 * states in which the question cannot be answered, which is all the caller needs
 * — and claiming a mechanism this cannot see is the mistake being fixed here.
 */
export function compositorBlindSpot(screen) {
  if (!screen) return null; // nothing was asked; the caller reports that separately
  if (screen.screenLocked) return 'the screen is locked, so only the lock window is composited';
  if (!(screen.systemOnScreen > 0)) {
    return (
      'no window of any application is on screen — the display is asleep, or the ' +
      'active Space is showing a fullscreen app'
    );
  }
  return null;
}

// Every Chrome process owns a crowd of 1x1 probe windows and 1512x33 menubar
// strips, so "the window the user is meant to see" can only be picked out by
// geometry: a content-sized window sitting where Chrome says its window is.
// macOS rounds and clamps placement by a pixel or two, hence the tolerance.
export function screenWindowAt(list, bounds) {
  const near = (a, b) => Math.abs(a - b) <= 8;
  return (
    list.find(
      (w) =>
        w.width >= 400 &&
        w.height >= 300 &&
        near(w.left, bounds.left) &&
        near(w.top, bounds.top) &&
        near(w.width, bounds.width)
    ) ?? null
  );
}

// Status may use Chrome's bounds to identify its window, but never to decide
// whether that window is visible. Only the window server sees the final alpha,
// position and on-screen state that a human actually gets.
export function measuredWindowState(wins, screen) {
  if (!wins.length || !screen || compositorBlindSpot(screen)) return 'unknown';
  const near = (a, b) => Math.abs(a - b) <= 8;
  const states = wins.map((win) => {
    const bounds = win.bounds;
    if (!bounds) return 'unknown';
    const sameSize = screen.windows.filter(
      (w) =>
        w.width >= 400 &&
        w.height >= 300 &&
        near(w.width, bounds.width) &&
        near(w.height, bounds.height)
    );
    const real = screenWindowAt(screen.windows, bounds) ??
      (sameSize.length === 1 ? sameSize[0] : null);
    if (!real) return 'unknown';
    if (!(real.alpha > 0) || isParked(real)) return 'hidden';
    if (real.onScreen) return 'visible';
    if (bounds.windowState === 'minimized') return 'minimized';
    return 'unknown';
  });
  if (states.includes('visible')) return 'visible';
  if (states.every((state) => state === 'hidden')) return 'hidden';
  if (states.every((state) => state === 'minimized')) return 'minimized';
  return 'unknown';
}

// Re-run the un-cloak. The obvious belt-and-braces here — also calling the
// bundled `window_alpha 1 <pid>` tool — was measured and does NOT work:
// CGSSetWindowAlpha only binds windows owned by the *calling* process, so from a
// separate CLI it reports "N window(s) set to alpha 1.0", exits 0, and changes
// nothing. (Verified on macOS 25.2 against a live session: alpha stayed 0 after
// `window_alpha 1`, and only SIGUSR2 moved it.) A fallback that always claims
// success is worse than no fallback, so the retry re-fires the one mechanism
// that does work, after clearing the flags again in case a racing `hide` re-armed
// them under us.
function reassertShown(chrome) {
  for (const f of [hiddenFlagFor(chrome)].filter(Boolean)) {
    try {
      unlinkSync(f);
    } catch {}
  }
  if (chrome.managed) {
    try {
      process.kill(chrome.pid, 'SIGUSR2');
    } catch {}
  }
}

/**
 * Why this one window is not visible, or null if it is.
 *
 * Kept free of I/O so it can be run against window-server states that are hard
 * to stage on purpose — miniaturized, alpha 0, parked, gone. `cur` is what
 * Chrome believes (CDP bounds) and `screen` is what the window server reports;
 * the whole point is that those two disagree, and each disagreement means
 * something different to the user.
 *
 * `screen === null` means the window server could not be asked at all. That is
 * not evidence of visibility, so it returns null (no problem found) and the
 * caller has to say the alpha half went unchecked.
 *
 * A compositor blind spot (display asleep, screen locked) lands in that same
 * category: the query answered, but everything it says about what is on screen
 * describes the sleeping compositor rather than this window. It is not merely
 * `onScreen` that goes untrustworthy there — whether kCGWindowAlpha stays
 * truthful while nothing is being composited has never been measured, so the
 * honest move is to skip both halves and have the caller say so, rather than to
 * trade a false "miniaturized" for a false "fully transparent".
 */
export function classifyWindow(windowId, cur, screen, pid) {
  if (!cur) return `window ${windowId}: Chrome would not report its bounds`;
  if (cur.windowState !== 'normal') return `window ${windowId}: still ${cur.windowState}`;
  if (isParked(cur)) {
    return `window ${windowId}: still parked offscreen at (${cur.left}, ${cur.top})`;
  }
  // Both are bounds-only verification, reported by the caller.
  if (!screen) return null;
  if (compositorBlindSpot(screen)) return null;
  const real = screenWindowAt(screen.windows, cur);
  if (!real) {
    return (
      `window ${windowId}: Chrome reports ${cur.width}x${cur.height} at (${cur.left}, ${cur.top}), ` +
      `but the window server has no window of that size there for pid ${pid}`
    );
  }
  if (!real.onScreen) {
    // Hedged deliberately. The window really is not being composited — other
    // windows are, so this is a fact about this window and worth reporting — but
    // the window server does not say WHY, and the previous wording asserted the
    // Dock with total confidence. Being miniaturized is the usual cause; per
    // docs/window-and-focus.md, a window on another Space reads identically.
    return (
      `window ${windowId}: not on screen — other windows are being composited, this one ` +
      `is not. Usually that means it is miniaturized, sitting in the Dock's minimized ` +
      `tray: Chrome says 'normal' and its alpha and bounds look right, because a ` +
      `miniaturized window keeps both and Chrome never saw the minimize we did to it. ` +
      `A window left on another Space reads the same way.`
    );
  }
  if (!(real.alpha > 0)) {
    return (
      `window ${windowId}: positioned at (${cur.left}, ${cur.top}) but fully transparent ` +
      `(alpha ${real.alpha}) — nothing is being drawn`
    );
  }
  return null;
}

// Did `show` actually put a visible window on screen? Returns the reasons it did
// not (`problems` empty = verified) plus `unchecked`: why the window-server half
// of that question could not be answered, or null when it was. A bounds-only
// pass must not be reported as proof of visibility. Polls instead of sampling
// once because the show sequence settles asynchronously: SIGUSR2 is handled with
// a dispatch_async onto Chrome's main queue, and a bounds change takes a frame or
// two to reach the window server.
async function verifyShown(ws, chrome, windowIds) {
  let problems = [];
  let unchecked = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    problems = [];
    const screen = screenWindows(chrome.pid);
    unchecked =
      screen === null ? 'the window server could not be queried' : compositorBlindSpot(screen);
    for (const windowId of windowIds) {
      const cur = (await cdpSend(ws, 'Browser.getWindowBounds', { windowId }))?.bounds;
      const problem = classifyWindow(windowId, cur, screen, chrome.pid);
      if (problem) problems.push(problem);
    }
    if (!problems.length) return { problems, unchecked };
    await sleep(150);
  }
  return { problems, unchecked };
}

// Open a CDP connection and collect every browser window (a session can grow
// popup windows — window.open with no tab strip — beyond the first one).
async function openWindowSession(chrome) {
  if (!chrome.port) throw new Error(`Chrome pid ${chrome.pid} has no CDP port.`);
  const resp = await fetch(`http://127.0.0.1:${chrome.port}/json/version`);
  const { webSocketDebuggerUrl } = await resp.json();
  const listResp = await fetch(`http://127.0.0.1:${chrome.port}/json/list`);
  const targets = await listResp.json();
  const pages = targets.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('No page target found');

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const wins = [];
  for (const p of pages) {
    const w = await cdpSend(ws, 'Browser.getWindowForTarget', { targetId: p.id });
    if (w.windowId && !wins.some((x) => x.windowId === w.windowId)) wins.push(w);
  }
  return { ws, wins };
}

export async function windowControl(action, session = null) {
  const chrome = findChrome(session);
  if (chrome.managed && !chrome.runId) {
    throw new Error(
      `Chrome pid ${chrome.pid} predates run-id window state. Close and restart this session.`
    );
  }
  const { ws, wins } = await openWindowSession(chrome);
  const isMinimized = wins[0]?.bounds?.windowState === 'minimized';
  const isHidden = isAlphaHidden(chrome) || isMinimized;

  let doShow;
  if (action === 'show') doShow = true;
  else if (action === 'hide') doShow = false;
  else doShow = isHidden; // toggle

  if (doShow) {
    // Lift the hidden flag FIRST: while it exists the hooks re-cloak every
    // window the moment it orders front.
    for (const f of [hiddenFlagFor(chrome)].filter(Boolean)) {
      try {
        unlinkSync(f);
      } catch {}
    }
    // Placing the windows is its own step so the retry below can redo exactly it.
    const place = async () => {
      for (const [i, win] of wins.entries()) {
        await cdpSend(ws, 'Browser.setWindowBounds', {
          windowId: win.windowId,
          bounds: { windowState: 'normal' },
        });
        await waitForNormal(ws, win.windowId);
        // Cascade so multiple windows don't stack invisibly on top of each other.
        await setBoundsVerified(ws, win.windowId, {
          left: 100 + i * 40,
          top: 100 + i * 40,
          width: 1280,
          height: 800,
        });
      }
    };
    await place();
    if (chrome.managed) process.kill(chrome.pid, 'SIGUSR2'); // restore alpha
    activateApp(chrome.pid);

    // Verify rather than assert. Every step above is fire-and-forget — unlink,
    // setWindowBounds, a signal — and nothing in the sequence fails loudly, so
    // an unconditional "Window shown" is a claim this function has no evidence
    // for. It has been wrong in both directions already: a window left parked at
    // (-9999, -9999) by a hook out of sync with its flag files, and a correctly
    // positioned window still sitting at alpha 0.
    const count = `${wins.length} window${wins.length > 1 ? 's' : ''}`;
    const windowIds = wins.map((w) => w.windowId);
    let { problems, unchecked } = await verifyShown(ws, chrome, windowIds);
    if (problems.length) {
      // One retry before giving up: the cheap causes (a `hide` that re-armed the
      // flags between the unlink and now, a signal that arrived while the window
      // was still mid-transition) are fixed by simply doing it again, and having
      // to hand a working situation back to the user as a failure is its own bug.
      reassertShown(chrome);
      await place();
      activateApp(chrome.pid);
      ({ problems, unchecked } = await verifyShown(ws, chrome, windowIds));
    }
    if (!problems.length) {
      console.log(`Window shown (${count})`);
      if (unchecked) {
        // Deliberately not a warning and not a non-zero exit: `show` did every
        // step it knows how to do, and the bounds it can see are right. What is
        // missing is a second opinion, and saying "NOT verifiably visible" for a
        // missing second opinion is what sent a reader off fixing a working
        // browser for fifteen minutes.
        console.error(
          `\nweb-plane: note — visibility could not be double-checked, either way:\n` +
            `  ${unchecked}.\n` +
            `  While that holds, the window server answers "is this window on screen" the same\n` +
            `  for a visible window as for one in the Dock, so this check refuses to guess.\n` +
            `  What was verified: Chrome's own window state and bounds are right, and nothing\n` +
            `  here suggests the window is hidden. Wake the display and re-run 'show' if you\n` +
            `  need it confirmed.\n`
        );
      }
    } else {
      const hiddenFlag = hiddenFlagFor(chrome);
      const stillFlagged = hiddenFlag ? existsSync(hiddenFlag) : false;
      console.error(
        `\nweb-plane: WARNING — 'show' ran but the window is NOT verifiably visible (${count}):\n` +
          problems.map((p) => `  - ${p}`).join('\n') +
          '\n' +
          (stillFlagged
            ? `  - the standing-hidden flag ${hiddenFlag} is still on disk, so the\n` +
              `    injected hook re-cloaks each window as fast as show un-cloaks it\n`
            : '') +
          // The problems above came from Chrome alone in this case, so say so:
          // otherwise the list reads as though the window server confirmed them.
          (unchecked
            ? `  - note: ${unchecked},\n` +
              `    so the window server was not consulted — the above is Chrome's own report\n`
            : '') +
          `\n  This is session '${chrome.session ?? '(unnamed)'}', pid ${chrome.pid} — check that it is the one you\n` +
          `  meant. Otherwise the injected hook in this Chrome has drifted out of sync with\n` +
          `  the flag files it reads; restarting the session clears that:\n` +
          `    web-plane -s=${chrome.session ?? '<name>'} close   # then start it again\n` +
          `\n  If the numbers above look right and the screen is still blank, suspect a macOS\n` +
          `  Screen Time / parental-control block: its notice is drawn ON the Chrome window,\n` +
          `  so a transparent window hides the very message explaining why nothing is there.\n` +
          `  A page screenshot cannot show it — grab the whole screen instead:\n` +
          `    screencapture -x ./tmp/screen.png\n`
      );
      process.exitCode = 1;
    }
  } else {
    if (chrome.managed) {
      // Arm the standing-hidden flag so windows born while hidden get cloaked
      // by the dylib hooks instead of appearing on screen. The native cloak
      // preserves bounds and makes browser frames transparent + click-through,
      // so attached sheets keep the correct position and no invisible hit-test
      // strip is left at a clamped display edge.
      writeFileSync(hiddenFlagFor(chrome), chrome.runId);
      process.kill(chrome.pid, 'SIGUSR1');
    } else {
      // No suppression hook in this Chrome — minimizing is the safe fallback.
      // Say so: a minimized window is still in the Dock, still steals focus when
      // a popup opens, and still shows the user what the agent is doing. Silently
      // accepting this is how a broken stealth kernel went unnoticed for a week.
      console.error(
        `\nweb-plane: WARNING — this session has no suppression hook (it is running the\n` +
          `  system Chrome, not the clone), so 'hide' fell back to MINIMIZE. The window\n` +
          `  is still on screen in the Dock and popups will surface.\n` +
          `  Fix: web-plane install   (diagnose with: web-plane doctor)\n`
      );
      for (const win of wins) {
        await cdpSend(ws, 'Browser.setWindowBounds', {
          windowId: win.windowId,
          bounds: { windowState: 'minimized' },
        });
      }
    }
    console.log(chrome.managed ? 'Window hidden' : 'Window minimized (degraded)');
  }

  ws.close();
}

export async function getStatus(session = null) {
  let chrome;
  try {
    // Read-only, and the caller prints the session name it got back, so an
    // unqualified `status` may pick one instead of refusing.
    chrome = findChrome(session, { unique: false });
  } catch {
    return {
      running: false,
      pid: null,
      port: null,
      session: null,
      windowState: 'unknown',
      managed: false,
    };
  }
  let windowState = 'unknown';
  try {
    const { ws, wins } = await openWindowSession(chrome);
    ws.close();
    windowState = measuredWindowState(wins, screenWindows(chrome.pid));
  } catch {}
  return {
    running: true,
    pid: chrome.pid,
    port: chrome.port,
    session: chrome.session,
    windowState,
    // False means this Chrome is not the cloned binary web-plane launches, so
    // `hide` can only minimize it. Reporting it like any other session is how a
    // half-working stealth kernel passes for a working one.
    managed: chrome.managed,
  };
}

/**
 * `web-plane -s=<name> close`
 *
 * Closing used to proxy to playwright-cli, which answers from its own session
 * registry. That registry drops entries web-plane's ps scan still sees, so
 * `close` reported "not open" for a browser `status` and `doctor` were both
 * listing as running — and there was then no way to shut it down through the
 * tool at all. Resolve the target the same way every other web-plane command
 * does, from ps, so the three commands cannot disagree.
 */
export async function closeSession(session = null) {
  let chrome;
  try {
    chrome = findChrome(session);
  } catch (e) {
    console.error(e.message);
    return 1;
  }

  // SIGTERM lets Chrome flush the profile (cookies, sessions) on its way out;
  // SIGKILL is the fallback for a process that will not take the hint, and
  // costs the profile write it was in the middle of.
  try {
    process.kill(chrome.pid, 'SIGTERM');
  } catch {}
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try {
      execSync('sleep 0.25');
      process.kill(chrome.pid, 0);
    } catch {
      alive = false;
    }
  }
  if (alive) {
    try {
      process.kill(chrome.pid, 'SIGKILL');
    } catch {}
  }

  // Run ids make stale flags harmless; removing this run's flag is housekeeping.
  for (const f of [hiddenFlagFor(chrome)].filter(Boolean)) {
    try {
      unlinkSync(f);
    } catch {}
  }

  console.log(
    `Closed session '${chrome.session ?? '(unnamed)'}' (pid ${chrome.pid})` +
      (alive ? ' — did not exit on SIGTERM, killed' : '')
  );
  return 0;
}
