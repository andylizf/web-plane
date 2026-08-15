import { randomUUID } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { isAbsolute, join } from 'path';
import { paths } from './config.js';
import { runtimeVersionState } from './health.js';
import { findChrome } from './procs.js';

export const PANEL_PROTOCOL = 1;
export const PANEL_REQUEST_MAX_AGE_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function panelRequestPaths(runDir, runId, requestId) {
  const stem = `${runId}-${requestId}`;
  return {
    request: join(runDir, `.panel-request-${stem}.json`),
    response: join(runDir, `.panel-response-${stem}.json`),
  };
}

export function parsePanelArgs(args) {
  const action = args[0] ?? 'status';
  let path = null;
  let json = false;
  const unknown = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg.startsWith('--path=')) path = arg.slice('--path='.length);
    else if (arg === '--path' && args[i + 1]) path = args[++i];
    else unknown.push(arg);
  }
  if (!['status', 'accept', 'cancel'].includes(action)) {
    return { error: `unknown panel action '${action}' (expected status, accept, or cancel)` };
  }
  if (unknown.length) return { error: `unknown panel argument '${unknown[0]}'` };
  if (action === 'accept' && !path) return { error: "panel accept requires '--path /absolute/path'" };
  if (action !== 'accept' && path) return { error: `panel ${action} does not accept --path` };
  if (path && !isAbsolute(path)) return { error: `panel path must be absolute: ${path}` };
  return { action, path, json };
}

function requestError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } };
}

function validateChrome(chrome) {
  if (!chrome.managed) {
    return requestError(
      'UNMANAGED_BROWSER',
      `Chrome pid ${chrome.pid} is not using web-plane's injected runtime`
    );
  }
  if (!chrome.runId) {
    return requestError(
      'MISSING_RUN_ID',
      `Chrome pid ${chrome.pid} predates native panel control; close and restart the session`
    );
  }
  return null;
}

/**
 * Send one typed request to the injected AppKit bridge.
 *
 * Exported so the native integration test can drive its small host process
 * through the exact same transport as Chrome.
 */
export async function sendPanelRequest(
  chrome,
  request,
  { runDir = paths.runDir, timeoutMs = 5_000, now = Date.now, createdAtMs = null } = {}
) {
  const invalid = validateChrome(chrome);
  if (invalid) return invalid;

  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const files = panelRequestPaths(runDir, chrome.runId, id);
  const temp = `${files.request}.${process.pid}.tmp`;
  const envelope = {
    protocol: PANEL_PROTOCOL,
    id,
    createdAtMs: createdAtMs ?? now(),
    ...request,
  };

  try {
    writeFileSync(temp, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
    renameSync(temp, files.request);
    process.kill(chrome.pid, 'SIGINFO');

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (existsSync(files.response)) {
        const raw = readFileSync(files.response, 'utf8');
        const response = JSON.parse(raw);
        if (response.protocol !== PANEL_PROTOCOL || response.id !== id) {
          return requestError('INVALID_RESPONSE', 'native panel bridge returned a mismatched response');
        }
        return response;
      }
      await sleep(25);
    }
    return requestError(
      'PANEL_TIMEOUT',
      `native panel bridge did not respond within ${timeoutMs}ms`,
      { pid: chrome.pid }
    );
  } catch (error) {
    return requestError('PANEL_TRANSPORT_FAILED', error.message, { pid: chrome.pid });
  } finally {
    rmSync(temp, { force: true });
    rmSync(files.request, { force: true });
    rmSync(files.response, { force: true });
  }
}

export async function runPanelCommand(session, args) {
  const parsed = parsePanelArgs(args);
  if (parsed.error) return requestError('INVALID_ARGUMENT', parsed.error);

  // SIGINFO did not belong to older runtimes. Never signal a browser until the
  // installed dylib is known to speak this package's panel protocol.
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
  const invalid = validateChrome(chrome);
  if (invalid) return invalid;

  const state = await sendPanelRequest(chrome, { action: 'status' });
  if (!state.ok || parsed.action === 'status') return state;
  if (!state.panel) {
    const unsupported = state.unsupportedNativeUI?.class;
    return requestError(
      unsupported ? 'UNSUPPORTED_NATIVE_UI' : 'NO_PANEL',
      unsupported
        ? `visible native UI '${unsupported}' is not a supported Save/Open panel`
        : 'no active Save/Open panel'
    );
  }

  if (parsed.action === 'accept') {
    // Reject obvious mistakes before they reach AppKit. Open-panel existence and
    // save-panel parent checks are repeated natively because the state can change
    // between these two process boundaries.
    if (state.panel.kind === 'open' && !existsSync(parsed.path)) {
      return requestError('PATH_NOT_FOUND', `open target does not exist: ${parsed.path}`);
    }
    if (state.panel.kind === 'open') {
      try {
        statSync(parsed.path);
      } catch (error) {
        return requestError('PATH_NOT_ACCESSIBLE', error.message);
      }
    }
  }

  return sendPanelRequest(chrome, {
    action: parsed.action,
    path: parsed.path,
    panelId: state.panel.id,
  });
}
