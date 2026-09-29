import { execFileSync, execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { arch, homedir, platform } from 'os';
import { dirname, join, resolve } from 'path';
import { PROJECT_DIR } from './config.js';
import { recallLane } from './lane-state.js';

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

// agent-browser.js only spawns this native client and does not forward signals
// to it. Killing the wrapper on a timeout therefore orphaned the client, which
// kept running with no parent. Running the client directly makes a timeout
// stop the process that is actually waiting.
function nativeAgentBrowserBinary() {
  const os = platform();
  const osKey = os === 'darwin' ? 'darwin'
    : os === 'win32' ? 'win32'
      : os === 'linux' ? (linuxUsesMusl() ? 'linux-musl' : 'linux') : null;
  const archKey = ['x64', 'x86_64'].includes(arch()) ? 'x64'
    : ['arm64', 'aarch64'].includes(arch()) ? 'arm64' : null;
  if (!osKey || !archKey) return null;
  const binary = join(dirname(AGENT_BROWSER_ENTRY), `agent-browser-${osKey}-${archKey}${os === 'win32' ? '.exe' : ''}`);
  return existsSync(binary) ? binary : null;
}

function linuxUsesMusl() {
  try {
    return execSync('ldd --version 2>&1 || true', { encoding: 'utf8' }).toLowerCase().includes('musl');
  } catch {
    return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  }
}

// A lane command runs while its caller holds the profile-wide command lock, and
// spawnSync blocks the event loop, so nothing else can end it. An `eval` whose
// promise never settles used to hold that lock forever and turn every other
// agent's command on the profile into LANE_BUSY. Every driver call now has a
// ceiling unless its caller set one: a `wait --timeout N` gets N plus a margin,
// anything else WEB_PLANE_DRIVER_TIMEOUT_MS (default 60 s).
const DEFAULT_DRIVER_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MARGIN_MS = 15_000;

export function defaultDriverTimeout(args) {
  const waitIndex = args.indexOf('wait');
  if (waitIndex >= 0) {
    const flag = args.indexOf('--timeout', waitIndex);
    const requested = flag >= 0 ? Number(args[flag + 1]) : NaN;
    if (Number.isFinite(requested) && requested > 0) return requested + WAIT_TIMEOUT_MARGIN_MS;
  }
  const configured = Number(process.env.WEB_PLANE_DRIVER_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DRIVER_TIMEOUT_MS;
}

export function normalizeSpawnTimeout(result, { phase, timeoutMs }) {
  if (result?.error?.code !== 'ETIMEDOUT') return result;
  const message = `${phase} timed out after ${timeoutMs}ms`;
  const priorStderr = result.stderr == null ? '' : String(result.stderr).trim();
  const stderr = [priorStderr, message].filter(Boolean).join('\n');
  return { ...result, status: 124, stderr: `${stderr}\n`, timedOut: true };
}

/** Run web-plane's packaged agent-browser, never an unrelated PATH entry. */
export function runAgentBrowser(args, { cdpPort = null, ...options } = {}) {
  const value = (flag) => {
    const index = args.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
    return index < 0 ? null : args[index].includes('=')
      ? args[index].slice(flag.length + 1) : args[index + 1];
  };
  const session = value('--session') ?? 'default';
  const connectIndex = args.indexOf('connect');
  const endpoint = cdpPort ?? value('--cdp') ?? recallLane(session)?.port ??
    (connectIndex >= 0 ? args[connectIndex + 1] : null);
  const informational = !args.length || args.some(arg => ['--version', '-v', '--help', '-h'].includes(arg));
  if (!endpoint && !informational) {
    const stderr = 'web-plane: agent-browser requires a connected lane or an explicit --cdp endpoint. ' +
      'Use web-plane attach, or pass --cdp <port> for a manual connection.\n';
    if (options.stdio === 'inherit') process.stderr.write(stderr);
    return { status: 1, stdout: '', stderr };
  }
  // --cdp also sets the daemon's reconnect endpoint. A lost connection must
  // fail against that endpoint instead of launching a temporary Chrome.
  const driverArgs = endpoint && !value('--cdp') ? ['--cdp', String(endpoint), ...args] : args;
  // The override exists for tests that prove an old or broken dependency is
  // rejected. Production installs always use the package entry above.
  const override = process.env.WEB_PLANE_TEST_AGENT_BROWSER_BIN;
  const bounded = options.timeout === undefined && !informational;
  const env = driverEnvironment(options.env ?? process.env);
  const spawnOptions = bounded
    ? { ...options, env, timeout: defaultDriverTimeout(args), killSignal: options.killSignal ?? 'SIGTERM' }
    : { ...options, env };
  const native = override ? null : nativeAgentBrowserBinary();
  const result = override
    ? spawnSync(override, driverArgs, spawnOptions)
    : native
      ? spawnSync(native, driverArgs, spawnOptions)
      : spawnSync(process.execPath, [AGENT_BROWSER_ENTRY, ...driverArgs], spawnOptions);
  if (!bounded) return result;
  const command = args.find((arg, i) => !String(arg).startsWith('-') && !['--session', '--cdp'].includes(args[i - 1])) ?? 'command';
  const normalized = normalizeSpawnTimeout(result, {
    phase: `agent-browser ${command} for lane '${session}'`,
    timeoutMs: spawnOptions.timeout,
  });
  if (normalized.timedOut) {
    const note = `web-plane: stopped it so the profile's command lock is released; the page may still be running it. ` +
      'Raise WEB_PLANE_DRIVER_TIMEOUT_MS for a command that is meant to run longer.\n';
    if (options.stdio === 'inherit') process.stderr.write(normalized.stderr + note);
    else normalized.stderr += note;
  }
  return normalized;
}

// agent-browser reads these as the proxy of a browser it launches itself. It
// never launches one for web-plane, but a proxy URL with credentials still
// makes its daemon enable Fetch interception, for proxy authentication, on
// every tab in the shared Chrome. Each request then waits for that daemon to
// continue it, and 0.34.0 can lose the CDP connection that interception
// belongs to while the connection stays open, which stalls every tab until
// the daemon exits. A caller's proxy (an agent host routing its own API
// traffic) must therefore never reach the driver.
const DRIVER_PROXY_VARIABLES = [
  'AGENT_BROWSER_PROXY',
  'AGENT_BROWSER_PROXY_BYPASS',
  'AGENT_BROWSER_PROXY_USERNAME',
  'AGENT_BROWSER_PROXY_PASSWORD',
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
];

export function driverEnvironment(env) {
  const result = { ...env };
  for (const name of DRIVER_PROXY_VARIABLES) delete result[name];
  return result;
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
