/**
 * Can a window be observed as visible on this machine at all?
 *
 * Run before the integration suite so that "there is no usable display here"
 * cannot be mistaken for "web-plane failed to show a window" — and, more
 * importantly, so a locked screen cannot make the suite pass: while the screen
 * is locked macOS composites nothing, and every "the window is NOT on screen"
 * assertion becomes true for the wrong reason.
 */
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';
import { buildProbe, keepDisplayAwake, probe, requireLiveDisplay, requireMacGui } from '../helpers/browser.js';

requireMacGui();
const home = makeTmpDir('display-check');
const release = keepDisplayAwake();
try {
  const probeBin = buildProbe(home);
  const onScreen = await requireLiveDisplay(probeBin);
  const { session } = probe(probeBin, process.pid);
  console.log(
    `window server OK: ${onScreen} windows on screen, ` +
      `onConsole=${session.onConsole}, screenLocked=${session.screenLocked}`
  );
} finally {
  release();
  removeTmpDir(home);
}
