// Watch one window through: CDP minimize -> SIGUSR2 -> CDP normal.
//
// Written for the failure in `test 4` of hide-show.test.js, where SIGUSR2
// restores alpha but the window never comes back on screen. An earlier probe
// turned up something the test's own message does not describe: after the
// signal, the content window is absent from BOTH the Accessibility list and
// CGWindowList — not off-screen, gone from the enumerations. "Off-screen" and
// "gone" need different explanations, so this samples often enough to tell them
// apart and asks Chrome what it believes at each step alongside what the window
// server reports.
//
// Usage: node tests/tools/trace-minimize.mjs
import { makeTmpDir } from '../helpers/tmpdir.js';
import {
  buildProbe,
  buildRuntime,
  cdpClient,
  killQuietly,
  launchClone,
  probe,
} from '../helpers/browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = makeTmpDir('trace-minimize');
const probeBin = buildProbe(home);
const paths = buildRuntime(home);
const browser = await launchClone({ paths, session: 'tracemin' });

function snap(label) {
  const p = probe(probeBin, browser.pid);
  const content = (p.windows ?? []).filter((w) => w.w > 500 && w.h > 500);
  const ax = p.ax?.available ? JSON.stringify((p.ax.windows ?? []).map((w) => w.minimized)) : 'n/a';
  const desc = content.length
    ? content.map((w) => `#${w.number} a=${w.alpha} (${w.x},${w.y}) on=${w.inOnScreenList}`).join(' | ')
    : '** no content window in list **';
  console.log(`${label.padEnd(24)} ${desc}   ax.minimized=${ax}`);
}

async function chromeBelieves(cdp, windowId, label) {
  try {
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    console.log(`${''.padEnd(24)} chrome: ${JSON.stringify(bounds)}   (${label})`);
  } catch (e) {
    console.log(`${''.padEnd(24)} chrome: getWindowBounds FAILED — ${e.message}   (${label})`);
  }
}

const cdp = await cdpClient(browser.port);
const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });

snap('baseline');
await chromeBelieves(cdp, windowId, 'baseline');

console.log('\n-- CDP minimize --');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
await sleep(1500);
snap('after minimize');
await chromeBelieves(cdp, windowId, 'after minimize');

console.log('\n-- SIGUSR2 (deminiaturize + alpha 1) --');
process.kill(browser.pid, 'SIGUSR2');
for (const at of [200, 600, 1200, 2500, 5000]) {
  await sleep(at - (at === 200 ? 0 : [200, 600, 1200, 2500].filter((x) => x < at).pop()));
  snap(`+${at}ms`);
}
await chromeBelieves(cdp, windowId, 'after SIGUSR2');

console.log('\n-- CDP normal --');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
await sleep(2000);
snap('after normal');
await chromeBelieves(cdp, windowId, 'after normal');

const after = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
console.log(`\npage targets still alive: ${after.filter((t) => t.type === 'page').length}`);

cdp.close();
killQuietly(browser.pid);
