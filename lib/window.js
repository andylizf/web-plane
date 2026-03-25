import { execSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { STATE_FILE } from './config.js';

function getCdpPort() {
  const result = execSync(
    'ps aux | grep "Google Chrome" | grep -v Helper | grep -v grep | grep -o "remote-debugging-port=[0-9]*" | head -1 | cut -d= -f2',
    { encoding: 'utf8' }
  ).trim();
  if (!result) throw new Error('No Chrome CDP port found. Is the browser running?');
  return parseInt(result, 10);
}

function getChromePid() {
  const result = execSync(
    'ps aux | grep "Google Chrome" | grep -v Helper | grep -v grep | head -1',
    { encoding: 'utf8' }
  ).trim();
  if (!result) throw new Error('No Chrome process found. Is the browser running?');
  return parseInt(result.split(/\s+/)[1], 10);
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

export async function windowControl(action) {
  const port = getCdpPort();
  const chromePid = getChromePid();

  const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl } = await resp.json();
  const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResp.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.error('No page target found');
    process.exit(1);
  }

  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  const win = await cdpSend(ws, 'Browser.getWindowForTarget', { targetId: page.id });
  const isMinimized = win.bounds?.windowState === 'minimized';
  const isAlphaHidden = existsSync(STATE_FILE);
  const isHidden = isAlphaHidden || isMinimized;

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
    process.kill(chromePid, 'SIGUSR2');
    try {
      unlinkSync(STATE_FILE);
    } catch {}
    console.log('Window shown');
  } else {
    process.kill(chromePid, 'SIGUSR1');
    writeFileSync(STATE_FILE, String(chromePid));
    console.log('Window hidden');
  }

  ws.close();
}

export function getStatus() {
  try {
    const pid = getChromePid();
    const port = getCdpPort();
    const hidden = existsSync(STATE_FILE);
    return { running: true, pid, port, hidden };
  } catch {
    return { running: false, pid: null, port: null, hidden: false };
  }
}
