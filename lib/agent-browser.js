import { execFileSync, spawnSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { PROJECT_DIR } from './config.js';

// npm keeps dependency binaries private to the package that declared them. A
// global web-plane install therefore does not put agent-browser on the user's
// PATH, and consulting PATH here can silently select an older Homebrew copy.
// Invoke the pinned package entry with this process's Node instead.
export const AGENT_BROWSER_ENTRY = join(
  PROJECT_DIR,
  'node_modules',
  'agent-browser',
  'bin',
  'agent-browser.js'
);

export function normalizeSpawnTimeout(result, { phase, timeoutMs }) {
  if (result?.error?.code !== 'ETIMEDOUT') return result;
  const message = `${phase} timed out after ${timeoutMs}ms`;
  const priorStderr = result.stderr == null ? '' : String(result.stderr).trim();
  const stderr = [priorStderr, message].filter(Boolean).join('\n');
  return { ...result, status: 124, stderr: `${stderr}\n`, timedOut: true };
}

/** Run web-plane's packaged agent-browser, never an unrelated PATH entry. */
export function runAgentBrowser(args, options = {}) {
  // The override exists for tests that prove an old or broken dependency is
  // rejected. Production installs always use the package entry above.
  const override = process.env.WEB_PLANE_TEST_AGENT_BROWSER_BIN;
  return override
    ? spawnSync(override, args, options)
    : spawnSync(process.execPath, [AGENT_BROWSER_ENTRY, ...args], options);
}

const AGENT_BROWSER_SIDECAR_SUFFIXES = [
  'pid',
  'config',
  'version',
  'stream',
  'sock',
  'target',
];

function daemonIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function agentBrowserSidecarPaths(session) {
  if (!/^[A-Za-z0-9._-]+$/.test(session)) return null;
  const dir = resolve(
    process.env.AGENT_BROWSER_SOCKET_DIR ?? join(homedir(), '.agent-browser')
  );
  const stem = resolve(dir, session);
  if (dirname(stem) !== dir) return null;
  return Object.fromEntries(
    AGENT_BROWSER_SIDECAR_SUFFIXES.map((suffix) => [suffix, `${stem}.${suffix}`])
  );
}

function removeAgentBrowserSidecars(pathsForSession) {
  if (!pathsForSession) return;
  for (const path of Object.values(pathsForSession)) {
    try { unlinkSync(path); } catch {}
  }
}

/** Stop only the packaged daemon belonging to one lane; never close shared Chrome. */
export async function stopAgentBrowserDaemon(session, { timeoutMs = 2_000 } = {}) {
  const sidecars = agentBrowserSidecarPaths(session);
  if (!sidecars) return { stopped: false, reason: 'unsafe-session-name' };

  let pid;
  try {
    pid = Number(readFileSync(sidecars.pid, 'utf8').trim());
  } catch {
    removeAgentBrowserSidecars(sidecars);
    return { stopped: true, reason: 'not-running' };
  }
  if (!daemonIsAlive(pid)) {
    removeAgentBrowserSidecars(sidecars);
    return { stopped: true, reason: 'not-running', pid };
  }

  let command = '';
  try {
    command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
  } catch {}
  const packagedBinDir = `${join(PROJECT_DIR, 'node_modules', 'agent-browser', 'bin')}/`;
  if (!command.startsWith(packagedBinDir)) {
    return { stopped: false, reason: 'pid-owner-mismatch', pid, command };
  }

  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + timeoutMs;
  while (daemonIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (daemonIsAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (daemonIsAlive(pid)) return { stopped: false, reason: 'did-not-exit', pid };

  removeAgentBrowserSidecars(sidecars);
  return { stopped: true, reason: 'stopped', pid };
}
