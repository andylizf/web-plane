import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';
import { runCli } from '../helpers/cli.js';
import { screenWindows } from '../../lib/window.js';
import {
  buildProbe,
  buildRuntime,
  cdpClient,
  contentWindow,
  finishLaunchTransition,
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
 * The hide/show round trip, judged by the window server rather than by web-plane.
 *
 * This is the test that would have caught the bug that started all of this:
 * `show` restored a hidden window's alpha but never undid the miniaturize, so
 * the window came back opaque, correctly positioned, and still sitting in the
 * Dock's minimized tray — while every check web-plane could make said it was
 * fine. Chrome reported `windowState: normal` because Chrome never saw the
 * minimize; the window server reported alpha 1 at the right bounds because a
 * miniaturized window keeps both.
 *
 * So the assertions here deliberately do not ask web-plane whether it worked.
 * They ask CoreGraphics whether the window is on screen, and the Accessibility
 * API whether it is minimized — the two questions that separate "visible" from
 * "in the Dock".
 */

const SESSION = 'citest';

let home;
let paths;
let probeBin;
let browser;
let releaseDisplay;
/** Reported at the end so the run says out loud what it could not check. */
const uncovered = [];

before(async () => {
  requireMacGui();
  home = makeTmpDir('integration-home');
  releaseDisplay = keepDisplayAwake();
  probeBin = buildProbe(home);
  await requireLiveDisplay(probeBin);
  paths = buildRuntime(home);
  browser = await launchClone({ paths, session: SESSION });
});

after(() => {
  if (releaseDisplay) releaseDisplay();
  if (browser) killQuietly(browser.pid);
  if (home) removeTmpDir(home);
  // A pass with a check missing is not the same as a pass. Say so on stderr and
  // leave it where CI can copy it into the run summary.
  const note = join(REPO_ROOT, 'tmp', 'uncovered.txt');
  if (uncovered.length) {
    process.stderr.write(`\nNOT COVERED by this run:\n${uncovered.map((u) => `  - ${u}`).join('\n')}\n`);
    mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true });
    writeFileSync(note, uncovered.join('\n') + '\n');
  } else {
    rmSync(note, { force: true });
  }
});

const look = () => probe(probeBin, browser.pid);
const mainWindow = () => contentWindow(look());

function describeWindows(p) {
  return JSON.stringify(p.windows, null, 2);
}

test('the injected hook keeps the launch window off the screen entirely', async () => {
  // Zero flash is the product's first promise, and the only proof that the dylib
  // loaded at all: without injection the window is composited immediately and
  // there is nothing stealthy about anything that follows.
  const p = look();
  const w = contentWindow(p);
  assert.ok(w, `Chrome created no content-sized window:\n${describeWindows(p)}`);
  assert.equal(
    w.inOnScreenList,
    false,
    `the launch window reached the screen — DYLD injection did not take effect:\n${JSON.stringify(w)}`
  );
});

test('hide leaves the window transparent and off screen', async () => {
  await finishLaunchTransition(browser);

  const r = runCli([`-s=${SESSION}`, 'hide'], { home });
  assert.equal(r.code, 0, `hide failed:\n${r.all}`);
  // "minimized (degraded)" means web-plane could not find its suppression hook
  // and fell back to a Dock icon: still on screen, still stealing focus.
  assert.match(r.stdout, /Window hidden/, `hide degraded instead of cloaking:\n${r.all}`);

  // Hidden means transparent and out of the way — NOT gone from the compositor.
  // The window has to keep rendering or screenshots stop working, which is half
  // the point of hiding it this way rather than minimizing it. So the check is
  // alpha 0 (nothing reaches the screen) plus parked (an invisible window left
  // at the front of the z-order still swallows every click inside its frame).
  const { ok, last } = await waitFor(
    mainWindow,
    (w) => w && w.alpha === 0 && w.x + w.w <= 100
  );
  assert.ok(
    ok,
    `after hide the window is still drawing or still in the way: ${JSON.stringify(last)}`
  );
});

test('show puts a real window back on the screen', async () => {
  const r = runCli([`-s=${SESSION}`, 'show'], { home });

  // web-plane's own verdict, checked first because "exited 0 and printed
  // success" is precisely the claim that used to be false.
  assert.equal(r.code, 0, `show reported failure:\n${r.all}`);
  assert.match(r.stdout, /Window shown/, `show did not claim success:\n${r.all}`);
  assert.doesNotMatch(r.stderr, /WARNING/, `show warned about its own result:\n${r.stderr}`);

  // The independent half. If the fix in the SIGUSR2 handler is reverted, the
  // window comes back opaque and correctly positioned but still miniaturized,
  // and only these two lines can tell.
  const { ok, last } = await waitFor(mainWindow, (w) => w && w.inOnScreenList && w.alpha > 0);
  assert.ok(
    ok,
    `the window server does not have this window on screen after show — ` +
      `it is most likely still miniaturized in the Dock: ${JSON.stringify(last)}`
  );
  assert.equal(last.isOnscreenFlag, true, `window is not flagged on screen: ${JSON.stringify(last)}`);

  const ax = look().ax;
  if (ax.available) {
    assert.ok(ax.count > 0, 'the Accessibility API sees no window for this browser');
    assert.ok(
      ax.windows.some((w) => w.minimized === false),
      `every window this app owns is minimized according to the Accessibility API: ${JSON.stringify(ax)}`
    );
  } else {
    // Never silently: an unavailable check is a gap in the evidence, and the run
    // has to say so rather than let the pass look complete.
    uncovered.push(
      `Accessibility check of the shown window (AXUIElement said: ${ax.error}; ` +
        `trusted=${ax.trusted}). CoreGraphics on-screen evidence still applied.`
    );
  }
});

test('the show signal undoes the miniaturize, not just the alpha', async () => {
  // The contract the SIGUSR2 handler carries: hiding is two acts — miniaturize
  // and alpha 0 — so showing has to undo both. Tested at the signal rather than
  // through `web-plane show`, because on macOS 26 / Chrome 150 the CDP half of
  // show ("windowState: normal") deminiaturizes the window by itself, which
  // masks the handler entirely: the round trip above passes even with the
  // deminiaturize removed. That masking is Chrome's behaviour and it can change
  // — the comments in setBoundsVerified describe a desynced window silently
  // ignoring every bounds command, which is exactly when the signal is all
  // there is left.
  const cdp = await cdpClient(browser.port);
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });

  const parked = await waitFor(mainWindow, (w) => w && !w.inOnScreenList, { timeoutMs: 5000 });
  assert.ok(parked.ok, `could not get the window into the Dock: ${JSON.stringify(parked.last)}`);

  process.kill(browser.pid, 'SIGUSR1'); // the hide half
  await waitFor(mainWindow, (w) => w && w.alpha === 0, { timeoutMs: 3000 });
  process.kill(browser.pid, 'SIGUSR2'); // the show half: must undo BOTH acts

  const { ok, last } = await waitFor(
    mainWindow,
    (w) => w && w.inOnScreenList && w.alpha > 0,
    { timeoutMs: 6000 }
  );
  cdp.close();
  assert.ok(
    ok,
    `SIGUSR2 restored the alpha but left the window in the Dock's minimized tray — ` +
      `opaque, correctly positioned, and invisible: ${JSON.stringify(last)}`
  );

  const ax = look().ax;
  if (ax.available) {
    assert.ok(
      ax.windows.some((w) => w.minimized === false),
      `the Accessibility API still reports every window minimized: ${JSON.stringify(ax)}`
    );
  }
});

test("web-plane's own window-server query notices a window in the Dock", async () => {
  // The other half of the same fix. `show` asks this query whether anything is
  // on screen; asked with kCGWindowListOptionAll it answers yes for a window in
  // the Dock — alpha and bounds survive miniaturization untouched — and `show`
  // then reports success over an invisible window. Only the on-screen-only
  // query can tell the difference.
  const cdp = await cdpClient(browser.port);
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  const parked = await waitFor(mainWindow, (w) => w && !w.inOnScreenList, { timeoutMs: 5000 });
  cdp.close();
  assert.ok(parked.ok, `could not get the window into the Dock: ${JSON.stringify(parked.last)}`);

  const seen = await waitFor(
    () => screenWindows(browser.pid),
    (s) => s !== null && s.every((w) => !(w.onScreenCount > 0)),
    { timeoutMs: 4000 }
  );
  try {
    assert.ok(seen.last, 'web-plane could not query the window server at all');
    assert.ok(
      seen.ok,
      `web-plane's window-server query still counts ${seen.last[0]?.onScreenCount} on-screen ` +
        `window(s) for a browser whose window is in the Dock, so 'show' cannot tell a ` +
        `miniaturized window from a visible one: ${JSON.stringify(seen.last)}`
    );
  } finally {
    // Put the window back even when this fails, so the next test starts from the
    // state it expects rather than inheriting a minimized browser.
    runCli([`-s=${SESSION}`, 'show'], { home });
  }
});

test('a window opened while hidden never reaches the screen', async () => {
  // The standing-hidden flag exists for exactly this: a popup born while the
  // session is hidden orders itself front through a path that bypasses the
  // high-level methods, so without the hook on the ordering primitive it appears
  // on screen in front of the user.
  assert.equal(runCli([`-s=${SESSION}`, 'hide'], { home }).code, 0);

  const cdp = await cdpClient(browser.port);
  const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  cdp.close();
  assert.ok(created?.targetId, `could not open a second window: ${JSON.stringify(created)}`);

  const contentWindows = (p) => p.windows.filter((w) => w.w >= 400 && w.h >= 300);
  // Without this the test would pass on a browser that never opened the second
  // window at all — proving nothing about the hook that has to catch it.
  const born = await waitFor(look, (p) => contentWindows(p).length >= 2, { timeoutMs: 6000 });
  assert.ok(born.ok, `no second window was created:\n${describeWindows(born.last)}`);

  // Whatever windows exist now, none of them may be drawing anything.
  const { ok, last } = await waitFor(
    look,
    (p) => contentWindows(p).every((w) => w.alpha === 0 || !w.inOnScreenList),
    { timeoutMs: 4000 }
  );
  assert.ok(ok, `a window became visible while the session was hidden:\n${describeWindows(last)}`);
});

test('close stops the browser and removes the flags it left in /tmp', async () => {
  const pid = browser.pid;
  const hiddenFlag = `/tmp/.chrome-hidden-${pid}`;

  const r = runCli([`-s=${SESSION}`, 'close'], { home });
  assert.equal(r.code, 0, `close failed:\n${r.all}`);
  assert.match(r.stdout, new RegExp(`Closed session '${SESSION}'`));

  const { ok } = await waitFor(() => isAlive(pid), (alive) => !alive, { timeoutMs: 8000 });
  assert.ok(ok, `pid ${pid} is still running after close`);
  // A stale flag makes the *next* browser that lands on this pid look hidden.
  assert.equal(existsSync(hiddenFlag), false, `${hiddenFlag} outlived the process it named`);
});
