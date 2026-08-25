import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTmpDir } from '../helpers/tmpdir.js';

const runtime = makeTmpDir('profile-runtime');
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const {
  appendSessionEvent,
  ensureManagedLaunchConfig,
  prepareManagedProfile,
  prepareSessionLogs,
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
  ]) {
    assert.equal(state.browser.launchOptions.args.filter((arg) => arg === flag).length, 1);
  }
  assert.ok(first.backup);
  assert.equal(JSON.parse(readFileSync(first.backup, 'utf8')).custom.value, 9);
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
