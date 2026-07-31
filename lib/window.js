import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { STATE_FILE } from './config.js';
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

function stateFileFor(pid) {
  return `${STATE_FILE}-${pid}`;
}

function isAlphaHidden(pid) {
  if (existsSync(stateFileFor(pid))) return true;
  // Legacy single state file from older versions: only trust it if it names this pid.
  try {
    return parseInt(readFileSync(STATE_FILE, 'utf8'), 10) === pid;
  } catch {
    return false;
  }
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
// `isApplied(cur)` judges success — needed because macOS clamps far-offscreen
// positions, so an exact match can't always be expected.
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

// Parked = at most a sliver of the window remains inside any display's x-range
// (macOS refuses to push a window fully off; ~40px stays at a display edge).
export const isParked = (cur) => cur.left + cur.width <= 100;

// Standing-hidden flag read by the dylib hooks: while it exists, any window
// that orders front is immediately cloaked (alpha 0 + parked offscreen), so
// popups born while hidden never reach the screen. The hooks let the original
// orderFront run first — Chrome's window bookkeeping must stay truthful, or it
// starts ignoring CDP bounds commands entirely. (Do NOT re-arm the launch-time
// suppress file for this: its miniaturize-instead-of-orderFront trick is only
// safe before the first window exists.)
function hiddenFlagFor(pid) {
  return `/tmp/.chrome-hidden-${pid}`;
}

// The window server's own record of a pid's windows: where each one really is
// and what alpha is actually being composited. Needed because both halves of
// `show` only report on themselves and both can be wrong — CDP returns the
// bounds Chrome *believes* it has, and SIGUSR2 sets NSWindow.alphaValue, which
// is one layer above the alpha that reaches the screen. This is the only view
// that can contradict them.
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
    `var live = onScreen.filter(function (w) { return w.kCGWindowOwnerPID === ${pid} }).length`,
    'JSON.stringify(mine.map(function (w) { return { alpha: w.kCGWindowAlpha, left: w.kCGWindowBounds.X, top: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height, onScreenCount: live } }))',
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
  for (const f of [hiddenFlagFor(chrome.pid), stateFileFor(chrome.pid), STATE_FILE]) {
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
 */
export function classifyWindow(windowId, cur, screen, pid) {
  if (!cur) return `window ${windowId}: Chrome would not report its bounds`;
  if (cur.windowState !== 'normal') return `window ${windowId}: still ${cur.windowState}`;
  if (isParked(cur)) {
    return `window ${windowId}: still parked offscreen at (${cur.left}, ${cur.top})`;
  }
  if (!screen) return null; // bounds-only verification; reported by the caller
  const real = screenWindowAt(screen, cur);
  if (!real) {
    return (
      `window ${windowId}: Chrome reports ${cur.width}x${cur.height} at (${cur.left}, ${cur.top}), ` +
      `but the window server has no window of that size there for pid ${pid}`
    );
  }
  if (!(real.onScreenCount > 0)) {
    return (
      `window ${windowId}: miniaturized — it is in the Dock's minimized tray, ` +
      `not on screen. Chrome says 'normal' and its alpha and bounds look ` +
      `right, because a miniaturized window keeps both and Chrome never saw ` +
      `the minimize we did to it.`
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
// not (`problems` empty = verified) plus whether the alpha half of that question
// could be answered at all — a bounds-only pass must not be reported as proof of
// visibility. Polls instead of sampling once because the show sequence settles
// asynchronously: SIGUSR2 is handled with a dispatch_async onto Chrome's main
// queue, and a bounds change takes a frame or two to reach the window server.
async function verifyShown(ws, chrome, windowIds) {
  let problems = [];
  let alphaChecked = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    problems = [];
    const screen = screenWindows(chrome.pid);
    alphaChecked = screen !== null;
    for (const windowId of windowIds) {
      const cur = (await cdpSend(ws, 'Browser.getWindowBounds', { windowId }))?.bounds;
      const problem = classifyWindow(windowId, cur, screen, chrome.pid);
      if (problem) problems.push(problem);
    }
    if (!problems.length) return { problems, alphaChecked };
    await sleep(150);
  }
  return { problems, alphaChecked };
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
  const { ws, wins } = await openWindowSession(chrome);
  const isMinimized = wins[0]?.bounds?.windowState === 'minimized';
  const isHidden = isAlphaHidden(chrome.pid) || isMinimized;

  let doShow;
  if (action === 'show') doShow = true;
  else if (action === 'hide') doShow = false;
  else doShow = isHidden; // toggle

  if (doShow) {
    // Lift the hidden flag FIRST: while it exists the hooks re-cloak every
    // window the moment it orders front.
    for (const f of [hiddenFlagFor(chrome.pid), stateFileFor(chrome.pid), STATE_FILE]) {
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
    let { problems, alphaChecked } = await verifyShown(ws, chrome, windowIds);
    if (problems.length) {
      // One retry before giving up: the cheap causes (a `hide` that re-armed the
      // flags between the unlink and now, a signal that arrived while the window
      // was still mid-transition) are fixed by simply doing it again, and having
      // to hand a working situation back to the user as a failure is its own bug.
      reassertShown(chrome);
      await place();
      activateApp(chrome.pid);
      ({ problems, alphaChecked } = await verifyShown(ws, chrome, windowIds));
    }
    if (!problems.length) {
      console.log(`Window shown (${count})`);
      if (!alphaChecked) {
        console.error(
          `\nweb-plane: note — the window server could not be queried, so 'shown' only means\n` +
            `  Chrome's bounds are right. Whether anything is actually being composited\n` +
            `  (alpha > 0) was not checked.\n`
        );
      }
    } else {
      const stillFlagged = existsSync(hiddenFlagFor(chrome.pid));
      console.error(
        `\nweb-plane: WARNING — 'show' ran but the window is NOT verifiably visible (${count}):\n` +
          problems.map((p) => `  - ${p}`).join('\n') +
          '\n' +
          (stillFlagged
            ? `  - the standing-hidden flag ${hiddenFlagFor(chrome.pid)} is still on disk, so the\n` +
              `    injected hook re-cloaks each window as fast as show un-cloaks it\n`
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
      process.kill(chrome.pid, 'SIGUSR1'); // alpha 0 — instant invisibility
      // Park offscreen too: an invisible window left at the front of the
      // z-order still swallows every click inside its frame.
      for (const win of wins) {
        await setBoundsVerified(
          ws,
          win.windowId,
          { left: -9999, top: -9999 },
          isParked
        );
      }
      // Arm the standing-hidden flag so windows born while hidden get cloaked
      // by the dylib hooks instead of appearing on screen.
      writeFileSync(hiddenFlagFor(chrome.pid), String(chrome.pid));
      writeFileSync(stateFileFor(chrome.pid), String(chrome.pid));
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
      hidden: false,
      minimized: false,
      managed: false,
    };
  }
  let minimized = false;
  try {
    const { ws, wins } = await openWindowSession(chrome);
    ws.close();
    minimized = wins[0]?.bounds?.windowState === 'minimized';
  } catch {}
  return {
    running: true,
    pid: chrome.pid,
    port: chrome.port,
    session: chrome.session,
    hidden: isAlphaHidden(chrome.pid),
    minimized,
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

  // The pid-scoped flags outlive the process they named, and pids get reused —
  // a stale one makes isAlphaHidden lie about whatever lands on that pid next.
  for (const f of [hiddenFlagFor(chrome.pid), stateFileFor(chrome.pid)]) {
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
