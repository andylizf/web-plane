import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  paths,
  SYSTEM_CHROME,
  SYSTEM_CHROME_BIN,
  PATCH_MARKERS,
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

/** Are both playwright patches present? This is the load-bearing check. */
export function patchState() {
  const missing = [];
  for (const { file, marker, what } of PATCH_MARKERS) {
    const p = join(paths.playwrightDir, file);
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

/** Is the clone present, ad-hoc signed (injectable), and tracking system Chrome? */
export function cloneState() {
  if (!existsSync(paths.chromeBin)) return { ok: false, reason: 'no clone', clone: null, system: null };
  const flags = sh(`codesign -dv "${paths.chromeBin}" 2>&1`);
  const adhoc = /\bflags=\S*adhoc/.test(flags);
  const clone = plistVersion(paths.chromeApp);
  const system = existsSync(SYSTEM_CHROME_BIN) ? plistVersion(SYSTEM_CHROME) : null;
  const current = !system || !clone || clone === system;
  return {
    ok: adhoc && current,
    adhoc,
    current,
    clone,
    system,
    reason: !adhoc ? 'not ad-hoc signed' : !current ? 'version drift' : null,
  };
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
 * warning (never throws — a degraded browser still beats no browser) and
 * returns false when stealth is not actually in effect.
 */
export function warnIfDegraded({ prefix = 'web-plane' } = {}) {
  let ok = true;

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
    rows.push(
      clone.current
        ? ['✓', 'clone version', `${clone.clone} (matches system)`, null]
        : ['⚠', 'clone version', `${clone.clone} ≠ system ${clone.system}`, 'web-plane install']
    );
  }

  rows.push(
    existsSync(paths.dylib)
      ? ['✓', 'suppression dylib', paths.dylib, null]
      : ['✗', 'suppression dylib', 'not compiled', 'web-plane install']
  );
  if (!existsSync(paths.dylib)) bad++;

  const ab = agentBrowserState();
  if (!ab.installed) {
    rows.push(['⚠', 'agent-browser', 'not installed', 'npm i -g agent-browser']);
  } else {
    rows.push(
      ab.ok
        ? ['✓', 'agent-browser', `${ab.version} (>= ${MIN_AGENT_BROWSER})`, null]
        : [
            '⚠',
            'agent-browser',
            `${ab.version} — below ${MIN_AGENT_BROWSER}; concurrent sessions steal each other's tab`,
            'npm i -g agent-browser@latest',
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
