import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { CdpConnection } from './cdp-client.js';
import { appendLaneEvent, laneEventsPath } from './lane-events.js';

const THIS_FILE = fileURLToPath(import.meta.url);

function monitorKey(lane) {
  return createHash('sha256').update(lane).digest('hex');
}

export function laneMonitorPaths(lane) {
  const key = monitorKey(lane);
  return {
    pid: resolve(paths.runDir, `.lane-monitor-${key}.json`),
    ready: resolve(paths.runDir, `.lane-monitor-${key}.ready.json`),
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function stopLaneMonitor(lane) {
  const statePaths = laneMonitorPaths(lane);
  try {
    const state = JSON.parse(readFileSync(statePaths.pid, 'utf8'));
    if (processIsAlive(state.pid)) process.kill(state.pid, 'SIGTERM');
  } catch {}
  for (const path of [statePaths.pid, statePaths.ready]) {
    try { unlinkSync(path); } catch {}
  }
}

export async function startLaneMonitor({ lane, session, port, targetId }) {
  stopLaneMonitor(lane);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.runDir, 0o700);
  const statePaths = laneMonitorPaths(lane);
  const token = randomUUID();
  const config = { lane, session, port, targetId, token };
  const child = spawn(process.execPath, [THIS_FILE, '--worker', JSON.stringify(config)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  writeFileSync(
    statePaths.pid,
    `${JSON.stringify({ pid: child.pid, lane, session, targetId, token })}\n`,
    { mode: 0o600, flag: 'wx' }
  );

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const ready = JSON.parse(readFileSync(statePaths.ready, 'utf8'));
      if (ready.token === token) {
        return { pid: child.pid, events: laneEventsPath(session, lane) };
      }
    } catch {}
    if (!processIsAlive(child.pid)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  stopLaneMonitor(lane);
  throw new Error(`lane diagnostics did not become ready; inspect ${laneEventsPath(session, lane)}`);
}

function remoteValueText(arg) {
  if (Object.hasOwn(arg ?? {}, 'value')) {
    try { return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value); } catch {}
  }
  return arg?.description ?? arg?.unserializableValue ?? arg?.type ?? '';
}

async function runWorker(config) {
  const { lane, session, port, targetId, token } = config;
  const statePaths = laneMonitorPaths(lane);
  const requests = new Map();
  const connection = await CdpConnection.connect(port);
  let stopping = false;

  const record = (event) => appendLaneEvent(session, lane, event);
  const requestKey = (message) => `${message.sessionId ?? 'browser'}:${message.params?.requestId ?? ''}`;

  const enableSession = async (sessionId) => {
    await connection.send('Runtime.enable', {}, sessionId);
    await connection.send('Network.enable', {}, sessionId);
    await connection.send('Page.enable', {}, sessionId);
  };

  connection.onEvent((message) => {
    const params = message.params ?? {};
    if (message.method === 'Target.attachedToTarget') {
      const type = params.targetInfo?.type;
      if (params.sessionId && ['iframe', 'worker', 'shared_worker'].includes(type)) {
        enableSession(params.sessionId).catch((error) => record({
          type: 'monitor-error',
          operation: 'enable-child-target',
          message: error.message,
        }));
      }
      return;
    }
    if (message.method === 'Target.targetDestroyed' && params.targetId === targetId) {
      record({ type: 'target-lost', targetId });
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      record({
        type: 'console',
        level: params.type ?? 'log',
        text: (params.args ?? []).map(remoteValueText).filter(Boolean).join(' '),
      });
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails ?? {};
      record({
        type: 'page-error',
        text: details.exception?.description ?? details.text ?? 'Unknown page error',
        url: details.url ?? null,
        line: details.lineNumber ?? null,
        column: details.columnNumber ?? null,
      });
      return;
    }
    if (message.method === 'Network.requestWillBeSent') {
      const req = params.request ?? {};
      requests.set(requestKey(message), {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        resourceType: params.type ?? 'Other',
      });
      return;
    }
    if (message.method === 'Network.responseReceived') {
      const request = requests.get(requestKey(message)) ?? {};
      const response = params.response ?? {};
      if (Number(response.status) >= 400) {
        record({
          type: 'response-failed',
          ...request,
          status: response.status,
          statusText: response.statusText ?? '',
        });
      }
      return;
    }
    if (message.method === 'Network.loadingFailed') {
      const request = requests.get(requestKey(message)) ?? {};
      record({
        type: 'request-failed',
        ...request,
        errorText: params.errorText ?? 'Failed',
        canceled: Boolean(params.canceled),
        blockedReason: params.blockedReason ?? null,
      });
      requests.delete(requestKey(message));
      return;
    }
    if (message.method === 'Network.loadingFinished') requests.delete(requestKey(message));
  });

  let resolveClosed;
  const closed = new Promise((resolveClosedPromise) => (resolveClosed = resolveClosedPromise));
  connection.onClose(() => {
    if (!stopping) record({ type: 'browser-disconnected', targetId });
    resolveClosed();
  });

  await connection.send('Target.setDiscoverTargets', { discover: true });
  const mainSession = await connection.attachTarget(targetId);
  await connection.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    mainSession
  );
  await enableSession(mainSession);
  record({ type: 'monitor-ready', targetId, port, token });
  writeFileSync(statePaths.ready, `${JSON.stringify({ token, pid: process.pid })}\n`, {
    mode: 0o600,
    flag: 'wx',
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    record({ type: 'monitor-stopped', targetId });
    connection.close();
    resolveClosed();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await closed;
  for (const path of [statePaths.pid, statePaths.ready]) {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (state.token === token) unlinkSync(path);
    } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE && process.argv[2] === '--worker') {
  try {
    await runWorker(JSON.parse(process.argv[3]));
  } catch (error) {
    try {
      const config = JSON.parse(process.argv[3]);
      appendLaneEvent(config.session, config.lane, {
        type: 'monitor-error',
        message: error.message,
      });
    } catch {}
    process.exitCode = 1;
  }
}
