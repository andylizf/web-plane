import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  paths,
  PROJECT_DIR,
  SYSTEM_CHROME,
  SYSTEM_CHROME_BIN,
  PATCH_MARKERS,
  RUNTIME_VERSION,
  MIN_AGENT_BROWSER,
} from './config.js';
import { listChromeProcs } from './procs.js';

// web-plane's failure mode is degradation, not crashing: when the playwright
// patch is missing the stealth kernel quietly falls back to the *system* Chrome
// with no DYLD hook — windows appear, `hide` can only minimize, and nothing says
// so. Every check here exists to turn one of those silent fallbacks into a
// message. `doctor` prints them all; the runtime paths call the cheap ones.

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function plistVersion(app) {
  return sh(`defaults read "${join(app, 'Contents', 'Info.plist')}" CFBundleShortVersionString`);
}

function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function packageInstallState() {
  const checkout = existsSync(join(PROJECT_DIR, '.git'));
  return {
    ok: !checkout,
    reason: checkout ? 'running from a mutable git checkout' : 'immutable package copy',
  };
}

export function runtimeVersionState() {
  let installed = null;
  try {
    installed = readFileSync(paths.runtimeVersion, 'utf8').trim();
  } catch {}
  return {
    ok: installed === RUNTIME_VERSION,
    installed,
    expected: RUNTIME_VERSION,
    reason: installed
      ? `installed protocol ${installed} != package protocol ${RUNTIME_VERSION}`
      : 'runtime protocol version missing',
  };
}

/** Are both playwright patches present? This is the load-bearing check. */
export function patchState(playwrightDir = paths.playwrightDir) {
  const missing = [];
  for (const { file, marker, what } of PATCH_MARKERS) {
    const p = join(playwrightDir, file);
    if (!existsSync(p)) {
      missing.push({ file, marker, what, reason: 'file not found' });
      continue;
    }
    let body = '';
    try {
      body = readFileSync(p, 'utf8');
    } catch {
      missing.push({ file, marker, what, reason: 'unreadable' });
      continue;
    }
    if (!body.includes(marker)) missing.push({ file, marker, what, reason: 'marker absent' });
  }
  return { ok: missing.length === 0, missing };
}

export function dylibState() {
  if (!existsSync(paths.dylib)) return { ok: false, reason: 'not compiled' };
  try {
    const body = readFileSync(paths.dylib);
    if (!body.includes(Buffer.from('WEB_PLANE_RUN_ID'))) {
      return { ok: false, reason: 'run-id protocol marker absent' };
    }
    if (!body.includes(Buffer.from('.panel-request-'))) {
      return { ok: false, reason: 'native panel-control marker absent' };
    }
    if (!body.includes(Buffer.from('ui-status'))) {
      return { ok: false, reason: 'native UI-blocker marker absent' };
    }
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * Is `a` more recently written than `b`? Lives here rather than in install.js
 * because `cloneRefresh` and `install` must answer "is the clone stale" from the
 * same code — they used to answer it from different data and contradict each
 * other in public. See cloneRefresh.
 */
export function isNewer(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  return statSync(a).mtimeMs > statSync(b).mtimeMs;
}

/** Is the clone present, ad-hoc signed (injectable), and tracking system Chrome? */
export function cloneState() {
  if (!existsSync(paths.chromeBin)) {
    return { ok: false, reason: 'no clone', clone: null, system: null, drift: null };
  }
  const flags = sh(`codesign -dv "${paths.chromeBin}" 2>&1`);
  const adhoc = /\bflags=\S*adhoc/.test(flags);
  const clone = plistVersion(paths.chromeApp);
  const system = existsSync(SYSTEM_CHROME_BIN) ? plistVersion(SYSTEM_CHROME) : null;
  // Which way the versions differ, because the two directions are different
  // situations and only one of them is a problem. 'behind' is a stale clone: a
  // fingerprinting tell, fixed by re-cloning. 'ahead' is the clone having updated
  // itself in place — Chrome's own updater writes a new framework into whatever
  // bundle it is running from — and re-cloning would *downgrade* it to the system
  // version for no benefit. Reported as drift with no direction, 'ahead' was
  // being prescribed a re-clone that install then declined to perform.
  const order = !system || !clone ? 0 : cmp(clone, system);
  const drift = order < 0 ? 'behind' : order > 0 ? 'ahead' : null;
  return {
    ok: adhoc && drift !== 'behind',
    adhoc,
    current: drift === null,
    drift,
    clone,
    system,
    reason: !adhoc ? 'not ad-hoc signed' : drift === 'behind' ? 'clone behind system Chrome' : null,
  };
}

/**
 * Would `web-plane install` re-clone Chrome, and why — in words fit to show a
 * user.
 *
 * The one answer both `doctor` and `install` use, so that they cannot disagree.
 * They did: doctor compared `CFBundleShortVersionString` and warned on any
 * difference, `⚠ clone version 151.0.7922.76 ≠ system 150.0.7871.189`, with
 * `fix: web-plane install`; install compared the mtimes of the two launcher stubs
 * and answered `==> Chrome clone up to date`. Both were reading real state — the
 * clone had self-updated to 151 while the system Chrome sat at 150, and the
 * clone's stub had been rewritten more recently than the system's — so following
 * doctor's advice changed nothing and the warning came back every time.
 *
 * Versions decide it now, with the binary date kept only as a tie-breaker for the
 * case a version number cannot see: the system Chrome reinstalled or re-signed at
 * the same version, which leaves the clone a copy of a build that no longer
 * exists.
 */
export function cloneRefresh() {
  if (!existsSync(paths.chromeBin)) return { needed: true, why: 'no clone yet' };
  const { clone, system, drift } = cloneState();
  if (!clone || !system) {
    // A version that cannot be read is not evidence of anything, so fall back to
    // the older, cruder signal rather than guessing at either answer.
    const stale = isNewer(SYSTEM_CHROME_BIN, paths.chromeBin);
    return {
      needed: stale,
      why: `could not read both versions (clone ${clone || '?'}, system ${system || '?'}) — ${
        stale ? 'system binary is newer' : 'comparing binary dates found nothing newer'
      }`,
    };
  }
  if (drift === 'behind') return { needed: true, why: `${clone} — BEHIND system ${system}` };
  if (drift === 'ahead') {
    return {
      needed: false,
      why: `${clone} — ahead of system ${system}; the clone updated itself`,
    };
  }
  if (isNewer(SYSTEM_CHROME_BIN, paths.chromeBin)) {
    return { needed: true, why: `${clone} — system Chrome rebuilt since the clone was taken` };
  }
  return { needed: false, why: `${clone} (matches system)` };
}

/** Is agent-browser new enough to keep concurrent sessions on separate tabs? */
export function agentBrowserState() {
  const v = sh('agent-browser --version').split(/\s+/).pop() || '';
  if (!v) return { ok: false, installed: false, version: null };
  return { ok: cmp(v, MIN_AGENT_BROWSER) >= 0, installed: true, version: v };
}

/**
 * Running Chrome main processes, tagged with session + whether we manage them.
 * Re-exported (not reimplemented) so `doctor` can never disagree with the
 * commands about which browsers exist — the two used to parse `ps` separately.
 */
export const chromeProcs = listChromeProcs;

/**
 * The cheap pre-flight the runtime paths call before launching. Prints a loud
 * error and returns false when stealth is not actually in effect. Callers must
 * refuse a new launch on false: a visible fallback is not web-plane.
 */
export function warnIfDegraded({ prefix = 'web-plane' } = {}) {
  let ok = true;

  const runtime = runtimeVersionState();
  if (!runtime.ok) {
    ok = false;
    console.error(
      `\n${prefix}: ERROR — the installed runtime does not match this CLI package.\n` +
        `  ${runtime.reason}. Starting Chrome could flash a window or use the wrong state protocol.\n` +
        `  Refusing to launch. Fix: web-plane install   (then: web-plane doctor)\n`
    );
  }

  const patch = patchState();
  if (!patch.ok) {
    ok = false;
    console.error(
      `\n${prefix}: WARNING — stealth kernel is NOT active.\n` +
        `  The playwright patch is missing (${patch.missing.map((m) => m.reason).join(', ')}), so this\n` +
        `  session launches your SYSTEM Chrome with no window-suppression hook:\n` +
        `  the window will be visible and 'hide' can only minimize it.\n` +
        `  Fix: web-plane install   (then verify with: web-plane doctor)\n`
    );
  }

  const dylib = dylibState();
  if (!dylib.ok) {
    ok = false;
    console.error(
      `\n${prefix}: ERROR — suppression dylib is incompatible (${dylib.reason}).\n` +
        '  Refusing to launch. Fix: web-plane install   (then: web-plane doctor)\n'
    );
  }

  const clone = cloneState();
  if (patch.ok && !clone.ok) {
    ok = false;
    if (!clone.adhoc) {
      console.error(
        `\n${prefix}: WARNING — the cloned Chrome is not ad-hoc signed, so DYLD injection\n` +
          `  will fail and the window will flash on screen.\n` +
          `  Fix: web-plane install\n`
      );
    } else {
      // Only reachable for a clone that is BEHIND: a clone ahead of the system
      // Chrome is not a degraded install, and saying "lags" about it was wrong in
      // both fact and direction.
      console.error(
        `\n${prefix}: note — clone Chrome ${clone.clone} lags system Chrome ${clone.system}.\n` +
          `  Stealth still works, but the version mismatch is a fingerprinting tell.\n` +
          `  Fix: web-plane install\n`
      );
    }
  }

  return ok;
}

/** `web-plane doctor` — one place that answers "is any of this actually on?" */
export function doctor() {
  const rows = [];
  let bad = 0;

  const source = packageInstallState();
  rows.push(
    source.ok
      ? ['✓', 'CLI package', source.reason, null]
      : [
          '⚠',
          'CLI package',
          source.reason,
          'npm install -g github:andylizf/web-plane',
        ]
  );

  const runtime = runtimeVersionState();
  rows.push(
    runtime.ok
      ? ['✓', 'runtime protocol', `${runtime.installed} (matches CLI package)`, null]
      : ['✗', 'runtime protocol', `INVALID — ${runtime.reason}`, 'web-plane install']
  );
  if (!runtime.ok) bad++;

  const patch = patchState();
  rows.push(
    patch.ok
      ? ['✓', 'playwright patch', 'applied (browserType + crBrowser)', null]
      : [
          '✗',
          'playwright patch',
          `MISSING — ${patch.missing.map((m) => `${m.file.split('/').pop()} (${m.reason})`).join(', ')}`,
          'web-plane install',
        ]
  );
  if (!patch.ok) bad++;

  const clone = cloneState();
  if (!existsSync(paths.chromeBin)) {
    rows.push(['✗', 'clone Chrome', 'not present', 'web-plane install']);
    bad++;
  } else {
    rows.push(
      clone.adhoc
        ? ['✓', 'clone signature', 'adhoc (DYLD injection OK)', null]
        : ['✗', 'clone signature', 'not adhoc — injection will fail', 'web-plane install']
    );
    if (!clone.adhoc) bad++;
    // Keyed on what `install` would actually do, not on whether the two version
    // strings differ: a fix is only prescribed when running it would change
    // something. `why` names the direction, since only one direction is a problem.
    const refresh = cloneRefresh();
    rows.push(
      refresh.needed
        ? ['⚠', 'clone version', refresh.why, 'web-plane install']
        : ['✓', 'clone version', refresh.why, null]
    );
  }

  const dylib = dylibState();
  rows.push(
    dylib.ok
      ? ['✓', 'suppression dylib', 'run-id protocol present', null]
      : ['✗', 'suppression dylib', dylib.reason, 'web-plane install']
  );
  if (!dylib.ok) bad++;

  const ab = agentBrowserState();
  if (!ab.installed) {
    rows.push(['⚠', 'agent-browser', 'not installed', `npm i -g agent-browser@${MIN_AGENT_BROWSER}`]);
  } else {
    rows.push(
      ab.ok
        ? ['✓', 'agent-browser', `${ab.version} (>= ${MIN_AGENT_BROWSER})`, null]
        : [
            '⚠',
            'agent-browser',
            `${ab.version} — below ${MIN_AGENT_BROWSER}; strict tab binding unavailable`,
            `npm i -g agent-browser@${MIN_AGENT_BROWSER}`,
          ]
    );
  }

  const procs = chromeProcs().filter((p) => p.session);
  rows.push([
    procs.length ? '⚠' : '✓',
    'live sessions',
    procs.length ? `${procs.length} running (${procs.map((p) => p.session).join(', ')})` : 'none',
    procs.length ? 'web-plane -s=<name> close' : null,
  ]);

  const width = Math.max(...rows.map((r) => r[1].length));
  for (const [mark, name, detail, fix] of rows) {
    console.log(`${mark} ${name.padEnd(width)}  ${detail}`);
    if (fix) console.log(`  ${''.padEnd(width)}  fix: ${fix}`);
  }
  return bad === 0 ? 0 : 1;
}
