import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTmpDir } from '../helpers/tmpdir.js';

const runtime = makeTmpDir('profile-runtime');
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const {
  appendSessionEvent,
  backupChromeSessionState,
  ensureManagedLaunchConfig,
  prepareManagedProfile,
  prepareSessionLogs,
  quarantineChromeSessionState,
  sessionEvidencePaths,
} = await import(`../../lib/profile-runtime.js?test=${Date.now()}`);

test.after(() => rmSync(runtime, { recursive: true, force: true }));

function makeProfile(session, preferences) {
  const dir = join(runtime, 'profiles', session);
  mkdirSync(join(dir, 'Default'), { recursive: true });
  const path = join(dir, 'Default', 'Preferences');
  writeFileSync(path, JSON.stringify(preferences));
  return { dir, path };
}

test('launch preparation clears crash recovery and agent-hostile prompts atomically', () => {
  const profile = makeProfile('crashed', {
    profile: { exit_type: 'Crashed', custom: 7 },
    autofill: { profile_enabled: true, untouched: 'yes' },
    credentials_enable_service: true,
    unrelated: { remains: true },
  });
  const original = readFileSync(profile.path, 'utf8');

  const result = prepareManagedProfile('crashed');
  const state = JSON.parse(readFileSync(profile.path, 'utf8'));

  assert.equal(result.changed, true);
  assert.equal(state.profile.exit_type, 'Normal');
  assert.equal(state.profile.exited_cleanly, true);
  assert.equal(state.session.restore_on_startup, 1);
  assert.equal(state.profile.custom, 7);
  assert.equal(state.autofill.profile_enabled, false);
  assert.equal(state.autofill.credit_card_enabled, false);
  assert.equal(state.autofill.untouched, 'yes');
  assert.equal(state.credentials_enable_service, false);
  assert.equal(state.credentials_enable_autosignin, false);
  assert.deepEqual(state.unrelated, { remains: true });
  assert.equal(readFileSync(result.backup, 'utf8'), original);
  assert.equal(existsSync(`${profile.path}.web-plane-staged`), false);
});

test('launch preparation creates safe defaults for a fresh managed profile', () => {
  const result = prepareManagedProfile('fresh');
  const path = join(runtime, 'profiles', 'fresh', 'Default', 'Preferences');
  const state = JSON.parse(readFileSync(path, 'utf8'));

  assert.equal(result.changed, true);
  assert.equal(result.backup, null);
  assert.equal(state.profile.exit_type, 'Normal');
  assert.equal(state.profile.exited_cleanly, true);
  assert.equal(state.session.restore_on_startup, 1);
  assert.equal(state.autofill.profile_enabled, false);
  assert.equal(state.credentials_enable_service, false);
});

test('managed launch config preserves custom settings and adds required Chrome flags once', () => {
  mkdirSync(runtime, { recursive: true });
  const configPath = join(runtime, 'cli.config.json');
  writeFileSync(configPath, JSON.stringify({
    browser: { launchOptions: { args: ['--custom-flag'] }, isolated: true },
    custom: { value: 9 },
  }));

  const first = ensureManagedLaunchConfig();
  const state = JSON.parse(readFileSync(configPath, 'utf8'));
  const second = ensureManagedLaunchConfig();

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(state.custom.value, 9);
  assert.equal(state.browser.isolated, true);
  for (const flag of [
    '--start-minimized',
    '--disable-session-crashed-bubble',
    '--enable-logging',
    '--restore-last-session',
    '--profile-directory=Default',
  ]) {
    assert.equal(state.browser.launchOptions.args.filter((arg) => arg === flag).length, 1);
  }
  assert.ok(first.backup);
  assert.equal(JSON.parse(readFileSync(first.backup, 'utf8')).custom.value, 9);
});

test('managed launch config replaces an ambiguous inner-profile selection with Default', () => {
  mkdirSync(runtime, { recursive: true });
  const configPath = join(runtime, 'cli.config.json');
  writeFileSync(configPath, JSON.stringify({
    browser: {
      launchOptions: {
        args: ['--profile-directory=Profile 1', '--custom-flag'],
      },
    },
  }));

  ensureManagedLaunchConfig();
  const args = JSON.parse(readFileSync(configPath, 'utf8')).browser.launchOptions.args;
  assert.equal(args.includes('--profile-directory=Profile 1'), false);
  assert.equal(args.filter((arg) => arg === '--profile-directory=Default').length, 1);
  assert.equal(args.includes('--custom-flag'), true);
});

test('backs up modern and legacy Chrome session files with verified private copies', () => {
  const profile = makeProfile('restorable', {});
  const sessions = join(profile.dir, 'Default', 'Sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'Session_100'), 'modern-session');
  writeFileSync(join(sessions, 'Tabs_100'), 'modern-tabs');
  writeFileSync(join(profile.dir, 'Default', 'Last Session'), 'legacy-session');

  const backup = backupChromeSessionState('restorable');

  assert.ok(backup);
  assert.equal(readFileSync(join(backup.dir, 'Default', 'Sessions', 'Session_100'), 'utf8'), 'modern-session');
  assert.equal(readFileSync(join(backup.dir, 'Default', 'Sessions', 'Tabs_100'), 'utf8'), 'modern-tabs');
  assert.equal(readFileSync(join(backup.dir, 'Default', 'Last Session'), 'utf8'), 'legacy-session');
  assert.equal(statSync(backup.dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(backup.dir, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(backup.dir, 'Default', 'Sessions', 'Session_100')).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(backup.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 3);
  assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test('quarantine moves restore data only after retaining an independent backup', () => {
  const profile = makeProfile('poisoned', {});
  const sessions = join(profile.dir, 'Default', 'Sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'Session_200'), 'fatal-session');
  writeFileSync(join(profile.dir, 'Default', 'Current Tabs'), 'fatal-tabs');

  const result = quarantineChromeSessionState('poisoned');

  assert.ok(result.backup);
  assert.ok(result.quarantine);
  assert.equal(existsSync(sessions), false);
  assert.equal(existsSync(join(profile.dir, 'Default', 'Current Tabs')), false);
  assert.equal(
    readFileSync(join(result.backup.dir, 'Default', 'Sessions', 'Session_200'), 'utf8'),
    'fatal-session'
  );
  assert.equal(
    readFileSync(join(result.quarantine, 'Default', 'Sessions', 'Session_200'), 'utf8'),
    'fatal-session'
  );
  assert.equal(statSync(result.quarantine).mode & 0o777, 0o700);
});

test('session logs rotate without overwriting crash evidence and events are timestamped JSONL', () => {
  const paths = sessionEvidencePaths('main');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.browserLog, 'previous crash\n');

  const prepared = prepareSessionLogs('main');
  assert.equal(existsSync(paths.browserLog), false);
  assert.equal(readFileSync(prepared.rotatedBrowserLog, 'utf8'), 'previous crash\n');

  appendSessionEvent('main', { type: 'launch', attempt: 1 });
  const record = JSON.parse(readFileSync(paths.eventsLog, 'utf8').trim());
  assert.equal(record.type, 'launch');
  assert.equal(record.attempt, 1);
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readdirSync(paths.dir).filter((name) => name.startsWith('browser-')).length, 1);
});
