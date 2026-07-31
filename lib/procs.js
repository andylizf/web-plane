import { execSync } from 'child_process';
import { paths } from './config.js';

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
  return { pid, port, dir, session, managed: line.includes(paths.chromeBin) };
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
  return out.split('\n').map(parseChromeLine);
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
