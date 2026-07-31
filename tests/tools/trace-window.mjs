/**
 * Walk one session through launch → transition → hide → show, dumping what the
 * window server reports at every step.
 *
 * Kept in the repo because "the window is not where anyone says it is" is this
 * project's recurring failure, and the only way to work on it is to see all
 * three views (Chrome's, CoreGraphics', the Accessibility API's) side by side.
 *
 *   node tests/tools/trace-window.mjs [--keep]
 *
 * --keep leaves the browser and its runtime up for poking at by hand.
 */
import { runCli } from '../helpers/cli.js';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';
import {
  buildProbe,
  buildRuntime,
  cdpClient,
  contentWindow,
  finishLaunchTransition,
  killQuietly,
  launchClone,
  probe,
  requireMacGui,
} from '../helpers/browser.js';

const KEEP = process.argv.includes('--keep');
const SESSION = 'trace';

requireMacGui();
const home = makeTmpDir('trace-home');
console.log(`home: ${home}`);
const paths = buildRuntime(home);
const probeBin = buildProbe(home);
const browser = await launchClone({ paths, session: SESSION });
console.log(`chrome pid ${browser.pid}, cdp port ${browser.port}`);

async function chromeBounds() {
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) return null;
  const cdp = await cdpClient(browser.port);
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
  const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
  cdp.close();
  return { windowId, ...bounds };
}

async function dump(label) {
  const p = probe(probeBin, browser.pid);
  const content = contentWindow(p);
  console.log(`\n=== ${label} ===`);
  console.log(`chrome says : ${JSON.stringify(await chromeBounds())}`);
  console.log(`content win : ${JSON.stringify(content)}`);
  console.log(`ax          : ${JSON.stringify(p.ax)}`);
  console.log(`all windows :`);
  for (const w of p.windows) {
    console.log(
      `  #${w.number} ${w.w}x${w.h} @(${w.x},${w.y}) alpha=${w.alpha} layer=${w.layer} ` +
        `onscreenFlag=${w.isOnscreenFlag} inList=${w.inOnScreenList}`
    );
  }
}

await dump('after launch (suppress file present)');
await finishLaunchTransition(browser);
await dump('after launch transition (patch behaviour)');

console.log('\n$ web-plane hide');
console.log(runCli([`-s=${SESSION}`, 'hide'], { home }).all.trim());
await dump('after hide');

console.log('\n$ web-plane show');
const shown = runCli([`-s=${SESSION}`, 'show'], { home });
console.log(`exit ${shown.code}`);
console.log(shown.all.trim());
await dump('after show');

if (!KEEP) {
  killQuietly(browser.pid);
  removeTmpDir(home);
} else {
  console.log(`\nleft running: pid ${browser.pid}, home ${home}`);
}
