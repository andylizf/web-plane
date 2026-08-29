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

const runtime = makeTmpDir('lane-state');
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const {
  forgetLane,
  laneStatePaths,
  listLaneStates,
  recallLane,
  rememberLane,
  touchLaneCommand,
  updateLaneTarget,
} = await import(`../../lib/lane-state.js?test=${Date.now()}`);

test.after(() => rmSync(runtime, { recursive: true, force: true }));

test('stores full recovery state in a private atomic file with a hashed name', () => {
  const saved = rememberLane('application/main', 'signed-in', 61234, {
    targetId: 'OLD-TARGET',
    url: 'https://portal.example/form?token=private#address',
    title: 'Application',
    tabIndex: 2,
  });
  const paths = laneStatePaths('application/main');

  assert.equal(saved.version, 2);
  assert.equal(saved.lane, 'application/main');
  assert.equal(saved.session, 'signed-in');
  assert.equal(saved.port, 61234);
  assert.equal(saved.url, 'https://portal.example/form?token=private#address');
  assert.match(saved.openedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.lastCommandAt, saved.openedAt);
  assert.equal(Object.hasOwn(saved, 'keep'), false);
  assert.equal(statSync(paths.dir).mode & 0o777, 0o700);
  assert.equal(statSync(paths.state).mode & 0o777, 0o600);
  assert.doesNotMatch(paths.state, /application|main/);
  assert.deepEqual(recallLane('application/main'), saved);
  assert.equal(readdirSync(paths.dir).some((name) => name.includes('staged')), false);
});

test('merges monitor target updates without losing lane ownership', () => {
  const original = rememberLane('monitor', 'profile', 50000, {
    targetId: 'A',
    lastCommandAt: '2026-08-28T12:00:00.000Z',
  });
  const updated = updateLaneTarget('monitor', {
    targetId: 'B',
    url: 'https://example.test/next?private=yes',
    title: 'Next',
    tabIndex: 1,
  });

  assert.equal(updated.session, 'profile');
  assert.equal(updated.port, 50000);
  assert.equal(updated.targetId, 'B');
  assert.equal(updated.url, 'https://example.test/next?private=yes');
  assert.equal(updated.title, 'Next');
  assert.equal(updated.tabIndex, 1);
  assert.equal(updated.lastCommandAt, original.lastCommandAt);
  assert.match(updated.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('command leases are explicit and legacy keep state is removed', () => {
  rememberLane('leased', 'profile', 50001, {
    targetId: 'LEASED',
    lastCommandAt: '2026-08-28T12:00:00.000Z',
  });

  const touched = touchLaneCommand('leased', '2026-08-29T01:00:00.000Z');
  assert.equal(touched.lastCommandAt, '2026-08-29T01:00:00.000Z');
  assert.equal(Object.hasOwn(touched, 'keep'), false);
  assert.equal(touched.targetId, 'LEASED');

  const paths = laneStatePaths('legacy-kept');
  writeFileSync(paths.state, JSON.stringify({
    version: 1,
    lane: 'legacy-kept',
    session: 'profile',
    port: 50001,
    keep: true,
  }));
  const migrated = recallLane('legacy-kept');
  assert.equal(migrated.version, 2);
  assert.equal(Object.hasOwn(migrated, 'keep'), false);
});

test('lists only validated hashed lane records in the requested session', () => {
  rememberLane('first', 'shared', 50002, { targetId: 'FIRST' });
  rememberLane('second', 'shared', 50002, { targetId: 'SECOND' });
  rememberLane('foreign', 'other', 50003, { targetId: 'FOREIGN' });
  const paths = laneStatePaths('first');
  writeFileSync(join(paths.dir, 'malformed.json'), '{not-json');
  writeFileSync(join(paths.dir, 'unhashed.json'), JSON.stringify({
    version: 1,
    lane: 'unhashed',
    session: 'shared',
    port: 50002,
  }));
  writeFileSync(join(paths.dir, 'ignored.json.staged-123'), '{}');

  assert.deepEqual(
    listLaneStates('shared').map((state) => state.lane).sort(),
    ['first', 'second']
  );
  assert.deepEqual(
    listLaneStates().map((state) => state.lane).sort(),
    ['application/main', 'first', 'foreign', 'leased', 'legacy-kept', 'monitor', 'second']
  );
});

test('reads and privately migrates a safe legacy session-port record', () => {
  const paths = laneStatePaths('legacy');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(paths.dir, 'legacy.json'), JSON.stringify({ session: 'old-profile', port: 45555 }));

  const state = recallLane('legacy');

  assert.equal(state.version, 2);
  assert.equal(state.lane, 'legacy');
  assert.equal(state.session, 'old-profile');
  assert.equal(state.port, 45555);
  assert.equal(existsSync(paths.state), true);
  assert.equal(statSync(paths.state).mode & 0o777, 0o600);
  assert.equal(existsSync(join(paths.dir, 'legacy.json')), false);
});

test('never resolves an unsafe legacy lane name outside the private directory', () => {
  const escaped = join(runtime, 'escape.json');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(escaped, JSON.stringify({ session: 'wrong', port: 1 }));

  assert.equal(recallLane('../escape'), null);
  assert.equal(readFileSync(escaped, 'utf8'), JSON.stringify({ session: 'wrong', port: 1 }));
});

test('forget removes current and safe legacy records', () => {
  rememberLane('temporary', 'profile', 40000);
  const paths = laneStatePaths('temporary');
  writeFileSync(join(paths.dir, 'temporary.json'), '{}');

  forgetLane('temporary');

  assert.equal(existsSync(paths.state), false);
  assert.equal(existsSync(join(paths.dir, 'temporary.json')), false);
});
