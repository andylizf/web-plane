import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CLI_CONFIG, paths } from './config.js';

const MANAGED_CHROME_ARGS = [
  '--start-minimized',
  '--disable-session-crashed-bubble',
  '--enable-logging',
];

function token() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
}

function writeAtomic(path, content, mode = 0o600) {
  const staged = `${path}.web-plane-staged`;
  try {
    writeFileSync(staged, content, { mode, flag: 'wx' });
    renameSync(staged, path);
  } catch (error) {
    try { unlinkSync(staged); } catch {}
    throw error;
  }
}

function backupFile(path, category, name) {
  if (!existsSync(path)) return null;
  const dir = join(paths.runtimeBackupsDir, category);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const backup = join(dir, `${name}-${token()}.json`);
  writeFileSync(backup, readFileSync(path), { mode: 0o600, flag: 'wx' });
  return backup;
}

function managedProfileDir(session) {
  const dir = join(paths.profilesDir, session);
  if (!dir.startsWith(`${paths.profilesDir}/`)) {
    throw new Error(`session '${session}' resolves outside web-plane's profile directory`);
  }
  return dir;
}

/** Make a managed Chrome profile safe for unattended launch while it is idle. */
export function prepareManagedProfile(session) {
  const profileDir = managedProfileDir(session);
  const defaultDir = join(profileDir, 'Default');
  const preferences = join(defaultDir, 'Preferences');
  mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

  const existed = existsSync(preferences);
  const original = existed ? readFileSync(preferences, 'utf8') : '{}';
  const state = JSON.parse(original);
  state.profile = { ...(state.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
  state.autofill = {
    ...(state.autofill ?? {}),
    profile_enabled: false,
    credit_card_enabled: false,
  };
  state.credentials_enable_service = false;
  state.credentials_enable_autosignin = false;
  const next = JSON.stringify(state);
  if (existed && next === original) return { changed: false, backup: null, preferences };

  const backup = existed
    ? backupFile(preferences, 'profile-preferences', encodeURIComponent(session))
    : null;
  const mode = existed ? statSync(preferences).mode & 0o777 : 0o600;
  writeAtomic(preferences, next, mode);
  return { changed: true, backup, preferences };
}

function mergedManagedConfig(existing) {
  const currentBrowser = existing?.browser ?? {};
  const currentLaunch = currentBrowser.launchOptions ?? {};
  const args = [...new Set([...(currentLaunch.args ?? []), ...MANAGED_CHROME_ARGS])];
  return {
    ...existing,
    browser: {
      ...CLI_CONFIG.browser,
      ...currentBrowser,
      launchOptions: {
        ...CLI_CONFIG.browser.launchOptions,
        ...currentLaunch,
        args,
      },
    },
  };
}

/** Merge required launch flags without discarding local runtime customization. */
export function ensureManagedLaunchConfig() {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const existed = existsSync(paths.config);
  const original = existed ? readFileSync(paths.config, 'utf8') : null;
  const existing = original ? JSON.parse(original) : {};
  const next = JSON.stringify(mergedManagedConfig(existing));
  if (original === next) return { changed: false, backup: null, path: paths.config };
  const backup = existed ? backupFile(paths.config, 'cli-config', 'cli-config') : null;
  writeAtomic(paths.config, next, existed ? statSync(paths.config).mode & 0o777 : 0o600);
  return { changed: true, backup, path: paths.config };
}

export function sessionEvidencePaths(session) {
  const safe = encodeURIComponent(session);
  const dir = join(paths.runtimeDir, 'logs', 'sessions', safe);
  return {
    dir,
    browserLog: join(dir, 'browser.log'),
    eventsLog: join(dir, 'session-events.jsonl'),
  };
}

/** Retain the previous browser log before Chrome opens a new one. */
export function prepareSessionLogs(session) {
  const evidence = sessionEvidencePaths(session);
  mkdirSync(evidence.dir, { recursive: true, mode: 0o700 });
  chmodSync(evidence.dir, 0o700);
  let rotatedBrowserLog = null;
  if (existsSync(evidence.browserLog)) {
    rotatedBrowserLog = join(evidence.dir, `browser-${token()}.log`);
    renameSync(evidence.browserLog, rotatedBrowserLog);
  }
  return { ...evidence, rotatedBrowserLog };
}

export function appendSessionEvent(session, event) {
  const evidence = sessionEvidencePaths(session);
  mkdirSync(evidence.dir, { recursive: true, mode: 0o700 });
  appendFileSync(
    evidence.eventsLog,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    { mode: 0o600 }
  );
  chmodSync(evidence.eventsLog, 0o600);
  return evidence.eventsLog;
}
