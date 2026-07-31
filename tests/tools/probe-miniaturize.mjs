/**
 * Where is the deminiaturize in SIGUSR2 actually load-bearing?
 *
 * Measured on macOS 26.0 / Chrome 150 (a GitHub macos-latest runner), 2026-08-01:
 * in all four routes below Chrome reports `windowState: minimized` for a window
 * the injected hook miniaturized, and honours `setWindowBounds {windowState:
 * normal}` — so the CDP half of `web-plane show` brings the window back on its
 * own and the signal handler's deminiaturize never decides the outcome. An
 * end-to-end round-trip test therefore passes with that fix reverted, which is
 * why the suite tests the signal contract directly instead.
 *
 * That is Chrome's behaviour, not a guarantee. `setBoundsVerified` documents the
 * opposite case — a window whose state has desynced from AppKit silently ignores
 * every bounds command — and when that happens the signal is all that is left.
 * Re-run this after an OS or Chrome update to see whether the answer moved.
 *
 *   node tests/tools/probe-miniaturize.mjs [--mutate] [variant...]
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { runCli } from '../helpers/cli.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';
import {
  buildProbe,
  buildRuntime,
  cdpClient,
  contentWindow,
  finishLaunchTransition,
  keepDisplayAwake,
  killQuietly,
  launchClone,
  probe,
  requireLiveDisplay,
  requireMacGui,
} from '../helpers/browser.js';

const MUTATE = process.argv.includes('--mutate');
const DEMINIATURIZE = 'if ([w isMiniaturized]) [w deminiaturize:nil];';
const VARIANTS = ['hook-brings-front', 'hook-activates', 'hook-new-window', 'chrome-minimizes'];
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const variants = wanted.length ? wanted : VARIANTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

requireMacGui();
const release = keepDisplayAwake();
const home = makeTmpDir('miniaturize-home');
const probeBin = buildProbe(home);
await requireLiveDisplay(probeBin);

// Compile the dylib from a possibly-mutated copy of the source.
const src = join(home, 'window_suppress.m');
const original = readFileSync(join(REPO_ROOT, 'native', 'window_suppress.m'), 'utf8');
if (MUTATE && !original.includes(DEMINIATURIZE)) throw new Error('mutation target not found');
writeFileSync(src, MUTATE ? original.replace(DEMINIATURIZE, '/* mutated */') : original);
const paths = buildRuntime(home);
execSync(`cc -Wall -Werror -dynamiclib -framework AppKit -framework Foundation -o "${paths.dylib}" "${src}"`, {
  stdio: 'inherit',
});
console.log(`dylib: ${MUTATE ? 'MUTATED (no deminiaturize in SIGUSR2)' : 'as committed'}`);

for (const variant of variants) {
  const session = `mz-${variant}`;
  const browser = await launchClone({ paths, session });
  await finishLaunchTransition(browser);
  const cdp = await cdpClient(browser.port);
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });

  // Put the window somewhere visible first, so "not on screen" later means the
  // staging did something.
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 60, top: 60, width: 900, height: 600 },
  });
  await sleep(500);

  const suppress = browser.suppressFile;
  if (variant === 'hook-brings-front') {
    // The hook miniaturizes on orderFront while the suppress file exists.
    writeFileSync(suppress, '');
    await cdp.send('Page.bringToFront', {}, page.id);
    await sleep(700);
    rmSync(suppress, { force: true });
  } else if (variant === 'hook-activates') {
    writeFileSync(suppress, '');
    execSync(
      `osascript -l JavaScript -e 'ObjC.import("AppKit"); ` +
        `var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${browser.pid}); ` +
        `a.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps)'`,
      { stdio: 'ignore' }
    );
    await sleep(700);
    rmSync(suppress, { force: true });
  } else if (variant === 'hook-new-window') {
    writeFileSync(suppress, '');
    await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    await sleep(900);
    rmSync(suppress, { force: true });
  } else if (variant === 'chrome-minimizes') {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await sleep(700);
  }

  const staged = {
    chrome: (await cdp.send('Browser.getWindowBounds', { windowId })).bounds,
    window: contentWindow(probe(probeBin, browser.pid)),
  };
  const hide = runCli([`-s=${session}`, 'hide'], { home });
  await sleep(500);
  const show = runCli([`-s=${session}`, 'show'], { home });
  await sleep(1200);
  const after = {
    chrome: (await cdp.send('Browser.getWindowBounds', { windowId })).bounds,
    window: contentWindow(probe(probeBin, browser.pid)),
    ax: probe(probeBin, browser.pid).ax,
  };

  console.log(`\n### ${variant}`);
  console.log(`  staged   chrome=${staged.chrome?.windowState} onscreen=${staged.window?.inOnScreenList} win=${JSON.stringify(staged.window)}`);
  console.log(`  hide     exit ${hide.code} ${hide.stdout.trim()}`);
  console.log(`  show     exit ${show.code} ${show.stdout.trim().split('\n')[0]}`);
  console.log(`  after    chrome=${after.chrome?.windowState} win=${JSON.stringify(after.window)}`);
  console.log(`  ax       ${JSON.stringify(after.ax)}`);
  console.log(`  VISIBLE AFTER SHOW: ${Boolean(after.window?.inOnScreenList && after.window.alpha > 0)}`);

  cdp.close();
  killQuietly(browser.pid);
  await sleep(400);
}

release();
removeTmpDir(home);
