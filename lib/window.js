import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { STATE_FILE, paths } from './config.js';

// One entry per running Chrome main process (any Chrome, not just ours).
function listChromeProcs() {
  let out = '';
  try {
    out = execSync(
      'ps -axo pid=,command= | grep "Google Chrome" | grep -v Helper | grep -v grep',
      { encoding: 'utf8' }
    ).trim();
  } catch {
    return [];
  }
  if (!out) return [];
  return out.split('\n').map((raw) => {
    const line = raw.trim();
    const pid = parseInt(line.split(/\s+/)[0], 10);
    const port = parseInt(line.match(/--remote-debugging-port=(\d+)/)?.[1] ?? '0', 10);
    const dir = line.match(/--user-data-dir=(\S+)/)?.[1] ?? '';
    const session = dir.startsWith(paths.profilesDir + '/')
      ? dir.slice(paths.profilesDir.length + 1)
      : null;
    // Only the cloned Chrome carries the DYLD suppression hook (SIGUSR1/2 handlers).
    // Signaling any other Chrome would hit the default SIGUSR disposition and kill it.
    const managed = line.includes(paths.chromeBin);
    return { pid, port, dir, session, managed };
  });
}

function findChrome(session) {
  const procs = listChromeProcs();
  if (!procs.length) throw new Error('No Chrome process found. Is the browser running?');
  if (session) {
    const match = procs.find((p) => p.session === session);
    if (!match) {
      const names = procs.filter((p) => p.session).map((p) => p.session).join(', ') || 'none';
      throw new Error(`No Chrome process for session "${session}" (sessions running: ${names})`);
    }
    return match;
  }
  return procs.find((p) => p.managed) || procs[0];
}

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
const isParked = (cur) => cur.left + cur.width <= 100;

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
    if (chrome.managed) process.kill(chrome.pid, 'SIGUSR2'); // restore alpha
    activateApp(chrome.pid);
    console.log(`Window shown (${wins.length} window${wins.length > 1 ? 's' : ''})`);
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
      for (const win of wins) {
        await cdpSend(ws, 'Browser.setWindowBounds', {
          windowId: win.windowId,
          bounds: { windowState: 'minimized' },
        });
      }
    }
    console.log('Window hidden');
  }

  ws.close();
}

export async function getStatus(session = null) {
  let chrome;
  try {
    chrome = findChrome(session);
  } catch {
    return { running: false, pid: null, port: null, session: null, hidden: false, minimized: false };
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
  };
}
