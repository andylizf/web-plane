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

// Open a CDP connection and fetch the browser window for the first page target.
async function openWindowSession(chrome) {
  if (!chrome.port) throw new Error(`Chrome pid ${chrome.pid} has no CDP port.`);
  const resp = await fetch(`http://127.0.0.1:${chrome.port}/json/version`);
  const { webSocketDebuggerUrl } = await resp.json();
  const listResp = await fetch(`http://127.0.0.1:${chrome.port}/json/list`);
  const targets = await listResp.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found');

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const win = await cdpSend(ws, 'Browser.getWindowForTarget', { targetId: page.id });
  return { ws, win };
}

export async function windowControl(action, session = null) {
  const chrome = findChrome(session);
  const { ws, win } = await openWindowSession(chrome);
  const isMinimized = win.bounds?.windowState === 'minimized';
  const isHidden = isAlphaHidden(chrome.pid) || isMinimized;

  let doShow;
  if (action === 'show') doShow = true;
  else if (action === 'hide') doShow = false;
  else doShow = isHidden; // toggle

  if (doShow) {
    await cdpSend(ws, 'Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: { windowState: 'normal' },
    });
    await cdpSend(ws, 'Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: { left: 100, top: 100, width: 1280, height: 800 },
    });
    if (chrome.managed) process.kill(chrome.pid, 'SIGUSR2'); // restore alpha
    activateApp(chrome.pid);
    for (const f of [stateFileFor(chrome.pid), STATE_FILE]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    console.log('Window shown');
  } else {
    if (chrome.managed) {
      process.kill(chrome.pid, 'SIGUSR1'); // alpha 0 — instant invisibility
      // Park it offscreen too: an invisible window left at the front of the
      // z-order still swallows every click inside its frame.
      await cdpSend(ws, 'Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { left: -9999, top: -9999 },
      });
      writeFileSync(stateFileFor(chrome.pid), String(chrome.pid));
    } else {
      // No suppression hook in this Chrome — minimizing is the safe fallback.
      await cdpSend(ws, 'Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { windowState: 'minimized' },
      });
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
    const { ws, win } = await openWindowSession(chrome);
    ws.close();
    minimized = win.bounds?.windowState === 'minimized';
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
