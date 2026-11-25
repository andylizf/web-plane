import { execFileSync, execSync } from 'child_process';
import { paths } from './config.js';
import { proxyFromCommandLine } from './proxy.js';
import { CdpConnection } from './cdp-client.js';

function runIdFrom(raw) {
  return raw.match(/(?:^|\s)WEB_PLANE_RUN_ID=([0-9a-f-]{36})(?:\s|$)/)?.[1] ?? null;
}

function runIdFor(pid) {
  try {
    const command = execFileSync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return runIdFrom(command);
  } catch {
    return null;
  }
}

/**
 * Who is running which Chrome, read from the process table.
 *
 * The process table is the only source that cannot disagree with reality:
 * playwright-cli's session registry and web-plane's own flag files both outlive
 * the browsers they describe, and `close` once reported "not open" for a browser
 * `status` was still listing. Everything that has to name a browser resolves it
 * here so the commands cannot contradict each other.
 */

/**
 * One `ps` line → what web-plane needs to know about that browser.
 *
 * `managed` is the safety-critical field: only the cloned Chrome carries the
 * DYLD suppression hook, and therefore only it has SIGUSR1/SIGUSR2 handlers.
 * Signalling any other Chrome hits the default disposition and kills it — so a
 * wrong answer here does not degrade, it takes down the user's browser.
 */
export function parseChromeLine(raw) {
  const line = raw.trim();
  const pid = parseInt(line.split(/\s+/)[0], 10);
  const port = parseInt(line.match(/--remote-debugging-port=(\d+)/)?.[1] ?? '0', 10);
  const dir = line.match(/--user-data-dir=(\S+)/)?.[1] ?? '';
  const session = dir.startsWith(paths.profilesDir + '/')
    ? dir.slice(paths.profilesDir.length + 1)
    : null;
  return {
    pid,
    port,
    dir,
    session,
    managed: line.includes(paths.chromeBin),
    runId: runIdFrom(line),
    proxy: proxyFromCommandLine(line),
  };
}

/** One entry per running Chrome main process (any Chrome, not just ours). */
export function listChromeProcs() {
  let out = '';
  try {
    out = execSync(
      'ps -axo pid=,command= | grep "Google Chrome" | grep -v Helper | grep -v grep',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return [];
  }
  if (!out) return [];
  return out.split('\n').map((line) => {
    const proc = parseChromeLine(line);
    return proc.managed ? { ...proc, runId: runIdFor(proc.pid) } : proc;
  });
}

/**
 * Pick the browser a command should act on.
 *
 * `unique` is what an unqualified command does when several sessions are up:
 * refuse (the default — acting on the wrong browser is unrecoverable) or pick
 * the first (only for read-only callers that name their choice in the output).
 */
export function selectChrome(procs, session, { unique = true } = {}) {
  if (!procs.length) throw new Error('No Chrome process found. Is the browser running?');
  if (session) {
    const match = procs.find((p) => p.session === session);
    if (!match) {
      const names = procs.filter((p) => p.session).map((p) => p.session).join(', ') || 'none';
      throw new Error(`No Chrome process for session "${session}" (sessions running: ${names})`);
    }
    return match;
  }
  // With no -s, pick a web-plane session — never the user's own Chrome. Falling
  // back to procs[0] used to mean an unqualified `web-plane hide` could target
  // whatever Chrome happened to be first in `ps`, i.e. the browser the user is
  // reading this in.
  const candidates = procs.filter((p) => p.managed || p.session);
  // ...but "one of ours" is still not "the one you meant". With several sessions
  // up, an unqualified command silently picked the lowest pid and then reported
  // success about a browser the caller had never heard of: `show` announced
  // "Window shown" while the session actually being driven stayed parked
  // offscreen at alpha 0. There is no right guess to make here, so ask.
  if (unique && candidates.length > 1) {
    const names = candidates.map((p) => `${p.session ?? '(unnamed)'} (pid ${p.pid})`).join(', ');
    throw new Error(
      `${candidates.length} web-plane sessions are running — say which one:\n` +
        `  running: ${names}\n` +
        `  e.g. web-plane -s=${candidates[0].session ?? '<name>'} <command>`
    );
  }
  const ours = candidates[0];
  if (!ours) {
    const foreign = procs.length;
    throw new Error(
      `No web-plane session is running (${foreign} other Chrome process${foreign > 1 ? 'es' : ''} ` +
        `found, but web-plane will not touch a Chrome it did not start).\n` +
        `Start one with: web-plane -s=<name> cdp`
    );
  }
  return ours;
}

/** The browser named by `session`, or the only one we own. */
export function findChrome(session, opts = {}) {
  return selectChrome(listChromeProcs(), session, opts);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

// Long enough for a large profile to write its cookie, session and history
// stores; Chrome normally exits within a second of Browser.close.
export const GRACEFUL_CLOSE_MS = 15_000;

/**
 * Stop one Chrome main process the way quitting it would.
 *
 * SIGTERM is not that. Chrome exits on it in tens of milliseconds without
 * writing the cookie batch it holds in memory (it writes about every 30 s), so
 * a cookie set shortly before was lost at the next launch. Browser.close runs
 * Chrome's own shutdown, which writes every store first; it survives the
 * playwright-cli daemon that launched Chrome only because
 * patches/single-graceful-close-processLauncher.patch stops that daemon from
 * SIGKILLing the browser while it shuts down. Signals remain only as
 * a timed fallback, for a browser whose DevTools endpoint does not answer.
 * Acts on `chrome.pid` alone, never on a name or a pattern.
 */
export async function stopBrowser(chrome, { gracefulMs = GRACEFUL_CLOSE_MS } = {}) {
  const { pid, port } = chrome;
  if (!alive(pid)) return { stopped: true, how: 'already-exited' };
  if (port) {
    try {
      const cdp = await CdpConnection.connect(port, 3_000);
      // The socket closes as Chrome shuts down, so the reply may never come.
      cdp.send('Browser.close').catch(() => {});
      if (await exitWithin(pid, gracefulMs)) return { stopped: true, how: 'browser-close' };
    } catch {}
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  if (await exitWithin(pid, 5_000)) return { stopped: true, how: 'sigterm' };
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return { stopped: await exitWithin(pid, 2_000), how: 'sigkill' };
}
