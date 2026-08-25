/**
 * The browser contexts that currently own page targets.
 *
 * Multiple windows and popups are safe when they share one context. Page
 * targets split across contexts are different Chrome profiles (or an
 * equivalent isolated context), and web-plane cannot yet tell agent-browser
 * which one belongs to the selected session.
 */
export function livePageContextIds(targetInfos) {
  return [
    ...new Set(
      targetInfos
        .filter((target) => target.type === 'page')
        .map((target) => target.browserContextId || 'default')
    ),
  ].sort();
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = (Math.random() * 1e9) | 0;
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`${method} timed out`));
    }, 2000);
    function handler(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener('message', handler);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || `${method} failed`));
      else resolve(message.result);
    }
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Ask a live browser which contexts currently have an open page. */
export async function livePageContextIdsForPort(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  if (!webSocketDebuggerUrl) throw new Error('CDP endpoint did not publish a browser WebSocket');

  const ws = new WebSocket(webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('opening the browser WebSocket timed out')),
        2000
      );
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('could not open the browser WebSocket'));
        },
        { once: true }
      );
    });
    const { targetInfos = [] } = await send(ws, 'Target.getTargets');
    return livePageContextIds(targetInfos);
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

export function splitContextMessage(session, operation, count) {
  return (
    `web-plane: refusing to ${operation} session '${session}': Chrome has ${count} live ` +
    `browser contexts.\n` +
    `  Chrome exposed another isolated context; a managed sign-in can do this by\n` +
    `  opening another inner Chrome profile inside this web-plane session.\n` +
    `  web-plane cannot safely choose which profile owns the requested window or tab.\n` +
    `  Close the extra Chrome profile window, or close and restart this session, then retry.\n` +
    `  Inspect the on-disk split with: web-plane profiles`
  );
}
