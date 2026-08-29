import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANE_TTL_MS, paths, REAP_INTERVAL_MS } from './config.js';
import { stopAgentBrowserDaemon } from './agent-browser.js';
import { CdpConnection } from './cdp-client.js';
import { laneReapDecision, nextLaneSweepDelay } from './lane-lifecycle.js';
import { appendLaneEvent, laneEventsPath } from './lane-events.js';
import { forgetLane, recallLane, updateLaneTarget } from './lane-state.js';
import { acquireProfileCommandLock } from './profile-command-lock.js';
import { appendSessionEvent } from './profile-runtime.js';

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
  let mainSession = null;
  let mainFrameId = null;
  let reapTimer = null;
  let reaping = false;

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
    if (message.method === 'Target.targetInfoChanged' && params.targetInfo?.targetId === targetId) {
      updateLaneTarget(lane, {
        targetId,
        url: params.targetInfo.url,
        title: params.targetInfo.title,
      });
      return;
    }
    if (
      message.method === 'Page.frameNavigated' &&
      message.sessionId === mainSession &&
      !params.frame?.parentId
    ) {
      mainFrameId = params.frame.id;
      updateLaneTarget(lane, { targetId, url: params.frame.url });
      record({ type: 'navigation', kind: 'document', targetId, url: params.frame.url });
      return;
    }
    if (
      message.method === 'Page.navigatedWithinDocument' &&
      message.sessionId === mainSession &&
      params.frameId === mainFrameId
    ) {
      updateLaneTarget(lane, { targetId, url: params.url });
      record({ type: 'navigation', kind: 'same-document', targetId, url: params.url });
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
    if (message.method === 'Page.downloadWillBegin' || message.method === 'Browser.downloadWillBegin') {
      record({ type: 'download-started', guid: params.guid ?? null });
      return;
    }
    if (message.method === 'Page.downloadProgress' || message.method === 'Browser.downloadProgress') {
      record({
        type: 'download-progress',
        guid: params.guid ?? null,
        state: params.state ?? 'unknown',
      });
    }
  });

  let resolveClosed;
  const closed = new Promise((resolveClosedPromise) => (resolveClosed = resolveClosedPromise));
  connection.onClose(() => {
    if (!stopping) record({ type: 'browser-disconnected', targetId });
    resolveClosed();
  });

  await connection.send('Target.setDiscoverTargets', { discover: true });
  mainSession = await connection.attachTarget(targetId);
  await connection.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    mainSession
  );
  await enableSession(mainSession);
  const [{ frameTree }, { targetInfo }] = await Promise.all([
    connection.send('Page.getFrameTree', {}, mainSession),
    connection.send('Target.getTargetInfo', { targetId }),
  ]);
  mainFrameId = frameTree?.frame?.id ?? null;
  updateLaneTarget(lane, {
    targetId,
    url: targetInfo?.url,
    title: targetInfo?.title,
  });
  record({ type: 'monitor-ready', targetId, port, token });
  writeFileSync(statePaths.ready, `${JSON.stringify({ token, pid: process.pid })}\n`, {
    mode: 0o600,
    flag: 'wx',
  });

  const reapRecord = (type, details) => {
    appendSessionEvent(session, { type, lane, ...details });
    record({ type, ...details });
  };

  // The caller has re-read the lease while holding the profile command lock.
  // Target.closeTarget is deliberate: the hard timeout must not be cancelled
  // by beforeunload or other page-owned state.
  const closeReapTarget = async () => {
    try {
      const { targetInfos } = await connection.send('Target.getTargets', {}, null, 2_000);
      if (!targetInfos.some((target) => target.targetId === targetId)) {
        return { closed: true, reason: 'already-closed' };
      }
    } catch (error) {
      return { closed: false, reason: 'close-not-confirmed', error: error.message };
    }
    try {
      const result = await connection.send('Target.closeTarget', { targetId }, null, 5_000);
      if (result?.success === false) return { closed: false, reason: 'close-refused' };
    } catch (error) {
      return { closed: false, reason: 'close-failed', error: error.message };
    }

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        const { targetInfos } = await connection.send('Target.getTargets', {}, null, 2_000);
        if (!targetInfos.some((target) => target.targetId === targetId)) {
          return { closed: true, reason: 'hard-timeout' };
        }
      } catch (error) {
        return { closed: false, reason: 'close-not-confirmed', error: error.message };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    return { closed: false, reason: 'close-not-confirmed', targetPresent: true };
  };

  const sweep = async () => {
    if (stopping || reaping) return;
    const preliminary = recallLane(lane);
    if (!preliminary) return;
    const preliminaryCommandMs = Date.parse(preliminary?.lastCommandAt ?? '');
    if (
      Number.isFinite(preliminaryCommandMs) &&
      Date.now() - preliminaryCommandMs < LANE_TTL_MS
    ) return;

    reaping = true;
    let releaseLock = null;
    try {
      try {
        releaseLock = await acquireProfileCommandLock(session, { timeoutMs: 1_000 });
      } catch (error) {
        reapRecord('lane-reap-skipped', {
          ageMs: Number.isFinite(preliminaryCommandMs)
            ? Math.max(0, Date.now() - preliminaryCommandMs)
            : null,
          reason: 'profile-busy',
        });
        return Math.min(REAP_INTERVAL_MS, 5_000);
      }

      // Re-read after acquiring the lock so a command that renewed the lease
      // while this sweep was waiting always wins before the forced close.
      const current = recallLane(lane);
      const reapDecision = laneReapDecision({
        state: current,
        ttlMs: LANE_TTL_MS,
        targetId,
      });
      if (!reapDecision.eligible) {
        reapRecord('lane-reap-skipped', {
          ageMs: reapDecision.ageMs,
          reason: reapDecision.reason,
        });
        return reapDecision.reason === 'not-idle' ? null : REAP_INTERVAL_MS;
      }

      const closeResult = await closeReapTarget();
      if (!closeResult.closed) {
        reapRecord('lane-reap-skipped', {
          ageMs: reapDecision.ageMs,
          reason: closeResult.reason,
          ...(Object.hasOwn(closeResult, 'targetPresent')
            ? { targetPresent: closeResult.targetPresent }
            : {}),
          ...(closeResult.error ? { error: closeResult.error } : {}),
        });
        return Math.min(REAP_INTERVAL_MS, 60_000);
      }
      const daemon = await stopAgentBrowserDaemon(lane);
      if (!daemon.stopped) {
        reapRecord('lane-reap-skipped', {
          ageMs: reapDecision.ageMs,
          reason: 'daemon-cleanup-failed',
          daemonReason: daemon.reason,
        });
        return Math.min(REAP_INTERVAL_MS, 60_000);
      }
      forgetLane(lane);
      reapRecord('lane-reaped', {
        ageMs: reapDecision.ageMs,
        daemonStopped: daemon.stopped,
        daemonReason: daemon.reason,
        reason: closeResult.reason,
      });
      stopping = true;
      connection.close();
      resolveClosed();
    } catch (error) {
      reapRecord('lane-reap-skipped', {
        ageMs: Number.isFinite(preliminaryCommandMs)
          ? Math.max(0, Date.now() - preliminaryCommandMs)
          : null,
        reason: 'inspection-unknown',
        error: error.message,
      });
      return REAP_INTERVAL_MS;
    } finally {
      if (releaseLock) releaseLock();
      reaping = false;
    }
  };

  const nextSweepDelay = () => {
    return nextLaneSweepDelay({
      state: recallLane(lane),
      ttlMs: LANE_TTL_MS,
      intervalMs: REAP_INTERVAL_MS,
    });
  };

  const scheduleSweep = (delayMs = nextSweepDelay()) => {
    if (stopping) return;
    reapTimer = setTimeout(async () => {
      const retryDelay = await sweep();
      scheduleSweep(retryDelay ?? nextSweepDelay());
    }, delayMs);
  };
  scheduleSweep();

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (reapTimer) clearTimeout(reapTimer);
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
