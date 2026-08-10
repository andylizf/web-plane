/**
 * Is "no window is on screen" a fact about the window, or about the display?
 *
 * On 2026-08-10 `web-plane show` called a window that was plainly on screen
 * "miniaturized — it is in the Dock's minimized tray" three times in four
 * minutes. All three fell inside one 4m41s display-off interval in `pmset -g log`
 * (16:23:05 → 16:27:46 local), and the first `Window shown` came after the wake.
 * The mechanism: kCGWindowListOptionOnScreenOnly describes what the compositor is
 * drawing, and a sleeping display draws nothing for ANY application, so every
 * window everywhere drops off that list at once.
 *
 * This tool measures that claim with the product's own query — it imports
 * `screenWindows` from lib/window.js rather than reimplementing it, so what it
 * observes is exactly what the verifier sees.
 *
 *   node tests/tools/probe-display-sleep.mjs                  # watch (default)
 *   node tests/tools/probe-display-sleep.mjs --once
 *   node tests/tools/probe-display-sleep.mjs --sleep-display   # stage it directly
 *
 * Watch mode samples until it is stopped and prints every state change, so a
 * display that sleeps on its own idle timer proves the point with no
 * intervention. Samples are appended as JSONL to tmp/ so a run that is left
 * going survives the terminal it started in.
 *
 * --sleep-display stages the state on purpose with `pmset displaysleepnow` and
 * wakes the display again with `caffeinate -u`. It REFUSES to run where
 * `sysadminctl -screenLock status` reports an immediate lock delay: there the
 * measurement would lock the machine's owner out behind a password prompt, which
 * is not a cost this tool gets to impose (that is the case on the machine where
 * the bug was found, hence the timestamp correlation above and the synthetic unit
 * tests in tests/unit/window-verify.test.js).
 */
import { execSync, execFileSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { compositorBlindSpot, screenWindows } from '../../lib/window.js';
import { REPO_ROOT } from '../helpers/tmpdir.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const pid = Number(value('pid', process.pid));
const everyMs = Number(value('every', 10)) * 1000;
const OUT = join(REPO_ROOT, 'tmp', 'display-sleep-samples.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'darwin') throw new Error('macOS only: this reads the macOS window server');

function sample(note) {
  const screen = screenWindows(pid);
  const row = {
    at: new Date().toISOString(),
    note,
    // The three numbers the verifier's decision turns on.
    systemOnScreen: screen?.systemOnScreen ?? null,
    screenLocked: screen?.screenLocked ?? null,
    blindSpot: compositorBlindSpot(screen),
    mine: (screen?.windows ?? []).map((w) => ({ number: w.number, onScreen: w.onScreen, alpha: w.alpha })),
  };
  mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true });
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
  return row;
}

function line(row) {
  return (
    `${row.at}  systemOnScreen=${row.systemOnScreen}  locked=${row.screenLocked}  ` +
    `blindSpot=${row.blindSpot ? `"${row.blindSpot}"` : 'none'}` +
    (row.note ? `  [${row.note}]` : '')
  );
}

/** Whether locking is deferred enough that sleeping the display is safe to do here. */
function screenLockDelay() {
  try {
    const out = execSync('sysadminctl -screenLock status 2>&1', { encoding: 'utf8' });
    return out.match(/screenLock delay is (.+?)\s*$/m)?.[1] ?? out.trim();
  } catch {
    return 'unknown';
  }
}

console.log(`sampling with lib/window.js screenWindows(${pid}); appending to ${OUT}`);
console.log(`screen lock delay on this machine: ${screenLockDelay()}`);

if (flag('sleep-display')) {
  const delay = screenLockDelay();
  if (/immediate/i.test(delay)) {
    console.error(
      `\nREFUSING to sleep the display: the screen lock delay is "${delay}", so this would\n` +
        `lock the machine and demand a password from whoever is sitting at it. Run without\n` +
        `--sleep-display and let the display idle out, or measure on a machine whose lock is\n` +
        `deferred. The bug itself is already pinned down by the pmset/transcript correlation\n` +
        `in the header of this file and covered by unit tests over a synthetic state.\n`
    );
    process.exit(2);
  }
  console.log(line(sample('before displaysleepnow')));
  execSync('pmset displaysleepnow');
  await sleep(3000);
  const asleep = sample('display asleep');
  console.log(line(asleep));
  // Wake before reporting anything: leaving the display asleep is the one side
  // effect this tool must not walk away from.
  execFileSync('caffeinate', ['-u', '-t', '2']);
  await sleep(3000);
  const awake = sample('after wake');
  console.log(line(awake));

  const proven = asleep.systemOnScreen === 0 && awake.systemOnScreen > 0;
  console.log(
    `\nmachine-wide on-screen count: ${awake.systemOnScreen} awake -> ${asleep.systemOnScreen} asleep\n` +
      (proven
        ? `CONFIRMED: the on-screen list empties for the whole machine while the display sleeps,\n` +
          `so an individual window's absence from it says nothing until something is being drawn.`
        : `NOT confirmed on this machine — the count did not collapse to zero. The fix's\n` +
          `discriminator (compositorBlindSpot) assumes it does; investigate before trusting it.`)
  );
  process.exit(proven ? 0 : 1);
}

if (flag('once')) {
  console.log(line(sample('once')));
  process.exit(0);
}

// Watch mode. Prints the first sample and every change after it, so a natural
// display sleep is captured without touching anything.
let previous = null;
for (;;) {
  const row = sample(null);
  const key = `${row.systemOnScreen === 0}|${row.screenLocked}|${Boolean(row.blindSpot)}`;
  if (key !== previous) {
    console.log(line(row));
    previous = key;
  }
  await sleep(everyMs);
}
