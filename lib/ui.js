import { createHash } from 'crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths } from './config.js';
import { runtimeVersionState } from './health.js';
import { sendPanelRequest } from './panel.js';
import { findChrome } from './procs.js';

// Commands that remain useful while browser-owned UI is blocking page input.
// This is deliberately an allowlist: a new agent-browser command must not
// silently bypass the gate merely because web-plane has not learned its name.
const BLOCKER_SAFE_COMMANDS = new Set([
  'back',
  'close',
  'console',
  'errors',
  'eval',
  'forward',
  'get',
  'goto',
  'network',
  'open',
  'reload',
  'screenshot',
  'snapshot',
  'tab',
  'title',
  'url',
  'wait',
]);

function requestError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } };
}

function ownerPrefix(runId) {
  return `.ui-blocker-owner-${runId}-`;
}

function ownerPath(runId, blockerId) {
  const key = createHash('sha256').update(blockerId).digest('hex');
  return join(paths.runDir, `${ownerPrefix(runId)}${key}.json`);
}

function readBlockerOwner(runId, blockerId) {
  if (!runId) return null;
  try {
    const state = JSON.parse(readFileSync(ownerPath(runId, blockerId), 'utf8'));
    return state.id === blockerId && typeof state.lane === 'string' ? state.lane : null;
  } catch {
    return null;
  }
}

function removeInactiveOwners(runId, blockers) {
  if (!runId) return;
  const active = new Set(
    blockers
      .filter((blocker) => blocker.scope === 'tab')
      .map((blocker) => ownerPath(runId, blocker.id))
  );
  try {
    for (const name of readdirSync(paths.runDir)) {
      if (!name.startsWith(ownerPrefix(runId))) continue;
      const path = join(paths.runDir, name);
      if (!active.has(path)) rmSync(path, { force: true });
    }
  } catch {}
}

export function clearBlockerOwners(runId) {
  removeInactiveOwners(runId, []);
}

export function blockersForLane(blockers, lane) {
  if (!lane) return blockers;
  return blockers.filter(
    (blocker) => blocker.scope !== 'tab' || !blocker.ownerLane || blocker.ownerLane === lane
  );
}

export function rememberBlockerOwners(session, lane, blockers) {
  let chrome;
  try {
    chrome = findChrome(session);
  } catch {
    return;
  }
  if (!chrome.runId) return;
  for (const blocker of blockers) {
    if (blocker.scope !== 'tab' || readBlockerOwner(chrome.runId, blocker.id)) continue;
    try {
      writeFileSync(
        ownerPath(chrome.runId, blocker.id),
        JSON.stringify({ id: blocker.id, lane }),
        { mode: 0o600, flag: 'wx' }
      );
    } catch {}
  }
}

export function parseUIArgs(args) {
  const action = args[0] ?? 'status';
  if (action !== 'status') {
    return { error: `unknown ui action '${action}' (expected status)` };
  }
  if (args.length > 1) return { error: `unknown ui argument '${args[1]}'` };
  return { action };
}

// Detection belongs to the UI-owning layer; policy belongs here. Keeping the
// action map out of the native bridge means there is one declaration of what an
// agent may do, rather than copies that can drift across Objective-C and JS.
export function actionsForBlocker(blocker) {
  if (blocker.kind === 'browser-modal') return ['wait', 'show', 'abort-by-navigation'];
  if (blocker.kind === 'native-panel' && ['save', 'open'].includes(blocker.subtype)) {
    return ['wait', 'accept', 'cancel', 'show'];
  }
  return ['wait', 'show'];
}

export function addBlockerPolicy(blocker, session) {
  return {
    ...blocker,
    actions: actionsForBlocker(blocker),
    showCommand: `web-plane -s=${session} show`,
  };
}

export function laneCommandNeedsClearUI(args) {
  const command = args[0];
  return !command || !BLOCKER_SAFE_COMMANDS.has(command);
}

export function newBlockers(before = [], after = []) {
  const existing = new Set(before.map((blocker) => blocker.id));
  return after.filter((blocker) => !existing.has(blocker.id));
}

export function blockedLaneResult(command, blocker, { commandExecuted = false } = {}) {
  const timing = commandExecuted ? 'after' : 'before';
  return requestError(
    commandExecuted ? 'UI_BLOCKED_AFTER_COMMAND' : 'UI_BLOCKED',
    commandExecuted
      ? `agent-browser '${command}' completed, but blocking UI appeared before another page input`
      : `blocking UI is already active; agent-browser '${command}' was not sent`,
    { timing, command, commandExecuted, blocker }
  );
}

export async function getUIStatus(session, lane = null) {
  const runtime = runtimeVersionState();
  if (!runtime.ok) {
    return requestError(
      'RUNTIME_MISMATCH',
      `${runtime.reason}; run 'web-plane install', then restart the session`
    );
  }

  let chrome;
  try {
    chrome = findChrome(session);
  } catch (error) {
    return requestError('SESSION_NOT_FOUND', error.message);
  }

  const response = await sendPanelRequest(chrome, { action: 'ui-status' });
  if (!response.ok) return response;
  removeInactiveOwners(chrome.runId, response.blockers ?? []);
  const blockers = (response.blockers ?? []).map((blocker) => {
    const ownerLane = blocker.scope === 'tab'
      ? readBlockerOwner(chrome.runId, blocker.id)
      : null;
    return addBlockerPolicy(
      ownerLane ? { ...blocker, ownerLane } : blocker,
      chrome.session ?? session ?? 'default'
    );
  });
  return {
    ok: true,
    session: chrome.session ?? session ?? null,
    blockers: blockersForLane(blockers, lane),
  };
}

export async function runUICommand(session, args) {
  const parsed = parseUIArgs(args);
  if (parsed.error) return requestError('INVALID_ARGUMENT', parsed.error);
  return getUIStatus(session);
}
