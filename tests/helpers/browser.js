import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import { REPO_ROOT } from './tmpdir.js';

/**
 * Build a real, working web-plane runtime inside a throwaway $HOME, launch the
 * cloned Chrome under the DYLD hook, and look at the result with an observer
 * that is not web-plane.
 *
 * The clone is mandatory, not a convenience: DYLD_INSERT_LIBRARIES is only
 * honoured for an ad-hoc signed binary, and the system Chrome must never be
 * re-signed in place — that would break the user's own browser.
 */

export const SYSTEM_CHROME = '/Applications/Google Chrome.app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything the launch needs, compiled from *this* checkout's sources. */
export function buildRuntime(home) {
  const runtime = join(home, '.web-plane');
  const chromeApp = join(runtime, 'Chrome.app');
  const chromeBin = join(chromeApp, 'Contents', 'MacOS', 'Google Chrome');
  const dylib = join(runtime, 'window_suppress.dylib');
  mkdirSync(join(runtime, 'profiles'), { recursive: true });

  // APFS copy-on-write where available; a plain copy is only a fallback so the
  // test still runs on a non-APFS volume rather than silently skipping.
  try {
    execSync(`/bin/cp -Rc "${SYSTEM_CHROME}" "${chromeApp}"`, { stdio: 'ignore' });
  } catch {
    execSync(`/bin/cp -R "${SYSTEM_CHROME}" "${chromeApp}"`, { stdio: 'ignore' });
  }
  execSync(`xattr -cr "${chromeApp}" && codesign --force --sign - "${chromeBin}"`, { stdio: 'ignore' });

  const flags = execSync(`codesign -dv "${chromeBin}" 2>&1`, { encoding: 'utf8' });
  if (!/\bflags=\S*adhoc/.test(flags)) {
    throw new Error(`clone is not ad-hoc signed, DYLD injection cannot work:\n${flags}`);
  }

  execSync(
    `cc -Wall -Werror -dynamiclib -framework AppKit -framework Foundation -o "${dylib}" ` +
      `"${join(REPO_ROOT, 'native', 'window_suppress.m')}"`,
    { stdio: 'inherit' }
  );

  return { runtime, chromeApp, chromeBin, dylib, profilesDir: join(runtime, 'profiles') };
}

/** The independent observer. Compiled once per run, next to the runtime. */
export function buildProbe(home) {
  const bin = join(home, 'winprobe');
  execSync(
    `cc -Wall -Werror -framework CoreGraphics -framework CoreFoundation -framework ApplicationServices ` +
      `-o "${bin}" "${join(REPO_ROOT, 'tests', 'native', 'winprobe.m')}"`,
    { stdio: 'inherit' }
  );
  return bin;
}

export function probe(probeBin, pid) {
  return JSON.parse(execFileSync(probeBin, [String(pid)], { encoding: 'utf8' }));
}

/**
 * The window a human would be looking at: the largest one Chrome owns.
 *
 * Chrome keeps a crowd of 1x1 probe windows and thin menubar strips around, so
 * "is a window on screen" is meaningless without picking the right one first.
 */
export function contentWindow(p) {
  const candidates = p.windows.filter((w) => w.w >= 400 && w.h >= 300);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`CDP never came up on port ${port} within ${timeoutMs}ms`);
}

/**
 * Launch the cloned Chrome exactly as the patched playwright-cli does: the clone
 * binary, the dylib in DYLD_INSERT_LIBRARIES, a session-shaped --user-data-dir
 * and an explicit debugging port.
 *
 * Going through playwright-cli here would test a pinned third-party alpha build
 * more than it tests web-plane; what the product's own code cares about is the
 * process this produces — the same binary, the same hook, and a `ps` line web-plane
 * can resolve to a session it owns.
 */
export async function launchClone({ paths, session, port }) {
  const profileDir = join(paths.profilesDir, session);
  mkdirSync(profileDir, { recursive: true });
  const cdpPort = port ?? (await freePort());

  const proc = spawn(
    paths.chromeBin,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--start-minimized', // the marker the playwright patch keys the injection on
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      // A fresh profile otherwise asks the login keychain for an encryption key,
      // which blocks forever on a machine with no one to click Allow.
      '--use-mock-keychain',
      '--password-store=basic',
      'about:blank',
    ],
    {
      env: { ...process.env, DYLD_INSERT_LIBRARIES: paths.dylib },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    }
  );

  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`\n[launchClone] Chrome exited ${code}:\n${stderr.slice(-2000)}\n`);
    }
  });

  const version = await waitForCdp(cdpPort);
  return { proc, pid: proc.pid, port: cdpPort, version, suppressFile: `/tmp/.chrome-suppress-${proc.pid}` };
}

/** A minimal CDP client — enough to stage the states the tests need. */
export async function cdpClient(port) {
  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  return {
    send: (method, params) =>
      new Promise((resolve) => {
        const id = (Math.random() * 1e9) | 0;
        ws.addEventListener('message', function handler(e) {
          const d = JSON.parse(e.data);
          if (d.id === id) {
            ws.removeEventListener('message', handler);
            resolve(d.result ?? d.error);
          }
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

/**
 * What the patched crBrowser.js does once CDP is up: drop the launch-time
 * suppression so later windows can order front normally, then park the window
 * offscreen through CDP.
 *
 * Only this process's own suppress file is removed — the product's `rm -f
 * /tmp/.chrome-suppress-*` would reach into any other Chrome on the machine,
 * which a test must not do.
 */
export async function finishLaunchTransition({ pid, port, suppressFile }) {
  rmSync(suppressFile, { force: true });
  await sleep(100);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target after launch');

  const cdp = await cdpClient(port);
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: -9999, top: -9999, width: 800, height: 600 },
  });
  cdp.close();
  return { windowId, pid };
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killQuietly(pid) {
  if (!pid || !isAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * Poll a condition over the window server, returning the last observation either
 * way. Show settles asynchronously (SIGUSR2 is handled on Chrome's main queue,
 * and a bounds change takes a frame or two to reach the compositor), so a single
 * sample right after the command can be too early — but the timeout is generous
 * and the last observation is reported, so a real failure is not hidden by it.
 */
export async function waitFor(observe, ok, { timeoutMs = 4000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = observe();
  while (Date.now() < deadline) {
    last = observe();
    if (ok(last)) return { ok: true, last };
    await sleep(everyMs);
  }
  return { ok: false, last };
}

export function requireMacGui() {
  if (process.platform !== 'darwin') {
    throw new Error('this test needs macOS: it drives the macOS window server');
  }
  if (!existsSync(SYSTEM_CHROME)) {
    throw new Error(`Google Chrome is not installed at ${SYSTEM_CHROME}`);
  }
  try {
    execSync('cc --version', { stdio: 'ignore' });
  } catch {
    throw new Error('no C compiler: the DYLD hook cannot be built (install Xcode Command Line Tools)');
  }
}

/**
 * Hold the display awake for the duration of the run.
 *
 * Not a nicety: while the display sleeps the window server composites nothing,
 * every window in the machine reports `isOnscreen: false`, and half-finished
 * minimize animations freeze mid-flight. Run against a sleeping display, these
 * tests fail in exactly the way a genuinely broken `show` does — which is the
 * one confusion that would make them worthless.
 */
export function keepDisplayAwake() {
  const proc = spawn('caffeinate', ['-d', '-u', '-t', '900'], { stdio: 'ignore', detached: false });
  return () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
}

/**
 * Fail — never skip — when the machine cannot show a window at all.
 *
 * This has to run before anything else, because a locked screen does not merely
 * break the visibility assertion: it composites nothing, so every "the window is
 * NOT on screen" assertion passes for the wrong reason and the whole file goes
 * green while proving nothing. Locking is also not something the test can undo —
 * macOS has no unlock API — so the only honest response is to fail and say why.
 */
export async function requireLiveDisplay(probeBin) {
  const deadline = Date.now() + 10000;
  let seen = null;
  while (Date.now() < deadline) {
    seen = probe(probeBin, process.pid);
    if (seen.session.known && !seen.session.screenLocked && seen.systemOnScreen > 0) {
      return seen.systemOnScreen;
    }
    await sleep(500);
  }
  const why = !seen?.session?.known
    ? 'there is no window-server session here (no GUI login)'
    : seen.session.screenLocked
      ? 'the screen is LOCKED — while it is, macOS composites only the lock window, so no ' +
        'window of any app can be observed as visible. Unlock the Mac and re-run; there is no ' +
        'API to unlock it from here'
      : !seen.session.onConsole
        ? 'this session is not the console session, so it has no display to draw on'
        : `the window server has ${seen.systemOnScreen} windows on screen for the whole machine`;
  throw new Error(
    `cannot observe window visibility on this machine: ${why}. ` +
      `Refusing to run — these assertions would pass without proving anything.`
  );
}
