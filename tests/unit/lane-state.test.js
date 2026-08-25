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
  recallLane,
  rememberLane,
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

  assert.equal(saved.version, 1);
  assert.equal(saved.lane, 'application/main');
  assert.equal(saved.session, 'signed-in');
  assert.equal(saved.port, 61234);
  assert.equal(saved.url, 'https://portal.example/form?token=private#address');
  assert.equal(statSync(paths.dir).mode & 0o777, 0o700);
  assert.equal(statSync(paths.state).mode & 0o777, 0o600);
  assert.doesNotMatch(paths.state, /application|main/);
  assert.deepEqual(recallLane('application/main'), saved);
  assert.equal(readdirSync(paths.dir).some((name) => name.includes('staged')), false);
});

test('merges monitor target updates without losing lane ownership', () => {
  rememberLane('monitor', 'profile', 50000, { targetId: 'A' });
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
  assert.match(updated.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('reads and privately migrates a safe legacy session-port record', () => {
  const paths = laneStatePaths('legacy');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(paths.dir, 'legacy.json'), JSON.stringify({ session: 'old-profile', port: 45555 }));

  const state = recallLane('legacy');

  assert.equal(state.version, 1);
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
