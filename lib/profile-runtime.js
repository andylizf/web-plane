import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
  '--restore-last-session',
  '--profile-directory=Default',
];

const LEGACY_SESSION_FILES = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];

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

/** Chrome profile directories nested inside one web-plane user-data-dir. */
export function innerChromeProfiles(dir) {
  const found = new Set();
  try {
    const state = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'));
    for (const name of Object.keys(state?.profile?.info_cache ?? {})) {
      if (existsSync(join(dir, name))) found.add(name);
    }
  } catch {}

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name))) {
        found.add(entry.name);
      }
    }
  } catch {}

  return [...found].sort((a, b) => {
    if (a === 'Default') return -1;
    if (b === 'Default') return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sessionStateEntries(session) {
  const profileDir = managedProfileDir(session);
  const defaultDir = join(profileDir, 'Default');
  const entries = [];
  const sessionsDir = join(defaultDir, 'Sessions');
  if (existsSync(sessionsDir)) {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        throw new Error(`refusing to preserve unexpected Chrome session entry: ${entry.name}`);
      }
      entries.push({
        source: join(sessionsDir, entry.name),
        relative: join('Default', 'Sessions', entry.name),
      });
    }
  }
  for (const name of LEGACY_SESSION_FILES) {
    const source = join(defaultDir, name);
    if (existsSync(source)) entries.push({ source, relative: join('Default', name) });
  }
  return entries;
}

/** Copy every Chrome-native restore file before any launch is allowed to mutate it. */
export function backupChromeSessionState(session) {
  const entries = sessionStateEntries(session);
  if (!entries.length) return null;
  const dir = privateDirectory(join(
    paths.runtimeBackupsDir,
    'chrome-sessions',
    encodeURIComponent(session),
    `backup-${token()}`
  ));
  const files = [];
  for (const entry of entries) {
    const destination = join(dir, entry.relative);
    privateDirectory(join(destination, '..'));
    copyFileSync(entry.source, destination);
    chmodSync(destination, 0o600);
    const sha256 = fileHash(entry.source);
    if (fileHash(destination) !== sha256) {
      throw new Error(`Chrome session backup verification failed for ${entry.relative}`);
    }
    files.push({ relative: entry.relative, size: statSync(entry.source).size, sha256 });
  }
  const manifest = join(dir, 'manifest.json');
  writeAtomic(manifest, `${JSON.stringify({
    version: 1,
    session,
    createdAt: new Date().toISOString(),
    files,
  }, null, 2)}\n`);
  return { dir, manifest, files };
}

/** Move a restore set out of Chrome's live path only after a verified copy exists. */
export function quarantineChromeSessionState(session) {
  const backup = backupChromeSessionState(session);
  if (!backup) return { backup: null, quarantine: null, files: [] };
  const profileDir = managedProfileDir(session);
  const quarantine = privateDirectory(join(
    paths.runtimeBackupsDir,
    'chrome-sessions',
    encodeURIComponent(session),
    `quarantine-${token()}`
  ));
  const modern = join(profileDir, 'Default', 'Sessions');
  if (existsSync(modern)) {
    privateDirectory(join(quarantine, 'Default'));
    renameSync(modern, join(quarantine, 'Default', 'Sessions'));
  }
  for (const name of LEGACY_SESSION_FILES) {
    const source = join(profileDir, 'Default', name);
    if (!existsSync(source)) continue;
    const destination = join(quarantine, 'Default', name);
    privateDirectory(join(destination, '..'));
    renameSync(source, destination);
  }
  for (const file of backup.files) {
    const moved = join(quarantine, file.relative);
    if (!existsSync(moved) || fileHash(moved) !== file.sha256) {
      throw new Error(`Chrome session quarantine verification failed for ${file.relative}`);
    }
  }
  return { backup, quarantine, files: backup.files };
}

/** Make a managed Chrome profile safe for unattended launch while it is idle. */
export function prepareManagedProfile(session) {
  const profileDir = managedProfileDir(session);
  const defaultDir = join(profileDir, 'Default');
  const preferences = join(defaultDir, 'Preferences');
  mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
  const sessionBackup = backupChromeSessionState(session);

  const existed = existsSync(preferences);
  const original = existed ? readFileSync(preferences, 'utf8') : '{}';
  const state = JSON.parse(original);
  state.profile = { ...(state.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
  state.session = { ...(state.session ?? {}), restore_on_startup: 1 };
  state.autofill = {
    ...(state.autofill ?? {}),
    profile_enabled: false,
    credit_card_enabled: false,
  };
  state.credentials_enable_service = false;
  state.credentials_enable_autosignin = false;
  const next = JSON.stringify(state);
  if (existed && next === original) {
    return { changed: false, backup: null, sessionBackup, preferences };
  }

  const backup = existed
    ? backupFile(preferences, 'profile-preferences', encodeURIComponent(session))
    : null;
  const mode = existed ? statSync(preferences).mode & 0o777 : 0o600;
  writeAtomic(preferences, next, mode);
  return { changed: true, backup, sessionBackup, preferences };
}

function mergedManagedConfig(existing) {
  const currentBrowser = existing?.browser ?? {};
  const currentLaunch = currentBrowser.launchOptions ?? {};
  const existingArgs = (currentLaunch.args ?? []).filter(
    (arg) => !String(arg).startsWith('--profile-directory')
  );
  const args = [...new Set([...existingArgs, ...MANAGED_CHROME_ARGS])];
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
