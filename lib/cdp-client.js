/** Minimal browser-level CDP client shared by diagnostics and frame inspection. */
export class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.closeHandlers = new Set();

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? 'CDP command failed'));
        else resolve(message.result ?? {});
        return;
      }
      if (message.method) {
        for (const handler of this.handlers) handler(message);
      }
    });
    socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      for (const handler of this.closeHandlers) handler();
    });
  }

  static async connect(port, timeoutMs = 5000) {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`CDP version endpoint returned HTTP ${response.status}`);
    const { webSocketDebuggerUrl } = await response.json();
    if (!webSocketDebuggerUrl) throw new Error('CDP version endpoint returned no browser socket');
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP browser socket did not open')), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP browser socket failed to open'));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 5000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async attachTarget(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    if (!sessionId) throw new Error(`CDP did not attach target ${targetId}`);
    return sessionId;
  }

  close() {
    this.socket.close();
  }
}
