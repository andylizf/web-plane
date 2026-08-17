import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const testRoot = join(process.cwd(), 'tmp');
mkdirSync(testRoot, { recursive: true });
const runtime = mkdtempSync(join(testRoot, 'explicit-close-'));
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const { normalizeExplicitClose } = await import(`../../lib/window.js?test=${Date.now()}`);

test.after(() => rmSync(runtime, { recursive: true, force: true }));

function profile(session, exitType) {
  const dir = join(runtime, 'profiles', session);
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(
    join(dir, 'Default', 'Preferences'),
    JSON.stringify({ profile: { exit_type: exitType }, untouched: { value: 7 } })
  );
  return { session, dir };
}

test('an explicit close clears only the false crash state and records the mutation', () => {
  const chrome = profile('work', 'Crashed');
  const result = normalizeExplicitClose(chrome);
  const preferences = JSON.parse(readFileSync(join(chrome.dir, 'Default', 'Preferences'), 'utf8'));
  const backup = JSON.parse(readFileSync(result.backup, 'utf8'));

  assert.equal(result.changed, true);
  assert.equal(preferences.profile.exit_type, 'Normal');
  assert.deepEqual(preferences.untouched, { value: 7 });
  assert.equal(backup.session, 'work');
  assert.equal(backup.previousExitType, 'Crashed');
  assert.equal(backup.nextExitType, 'Normal');
});

test('a clean profile is left byte-for-byte unchanged', () => {
  const chrome = profile('clean', 'Normal');
  const path = join(chrome.dir, 'Default', 'Preferences');
  const before = readFileSync(path, 'utf8');

  assert.deepEqual(normalizeExplicitClose(chrome), { changed: false });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a profile outside web-plane ownership is never modified', () => {
  const outside = mkdtempSync(join(testRoot, 'foreign-profile-'));
  mkdirSync(join(outside, 'Default'));
  const path = join(outside, 'Default', 'Preferences');
  writeFileSync(path, JSON.stringify({ profile: { exit_type: 'Crashed' } }));

  assert.deepEqual(normalizeExplicitClose({ session: 'foreign', dir: outside }), { changed: false });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).profile.exit_type, 'Crashed');
  rmSync(outside, { recursive: true, force: true });
});
