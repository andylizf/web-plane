import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import test from 'node:test';

import { makeTmpDir } from '../helpers/tmpdir.js';

const runtime = makeTmpDir('profile-command-lock');
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const {
  acquireProfileCommandLock,
  profileCommandLockPath,
} = await import(`../../lib/profile-command-lock.js?test=${Date.now()}`);

test.after(() => rmSync(runtime, { recursive: true, force: true }));

test('serializes one profile, times out by name, and releases by token', async () => {
  const release = await acquireProfileCommandLock('shared');
  const path = profileCommandLockPath('shared');
  assert.equal(existsSync(path), true);
  await assert.rejects(
    acquireProfileCommandLock('shared', { timeoutMs: 40 }),
    (error) => error.code === 'LANE_BUSY' && /shared/.test(error.message)
  );

  const original = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...original, token: 'replacement-owner' }));
  release();
  assert.equal(existsSync(path), true, 'an old owner removed a replacement lock');
  rmSync(path);

  const secondRelease = await acquireProfileCommandLock('shared');
  secondRelease();
  assert.equal(existsSync(path), false);
});

test('recovers a dead owner only after the write grace period', async () => {
  const path = profileCommandLockPath('stale');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path, JSON.stringify({
    token: 'dead-owner',
    pid: 2147483647,
    session: 'stale',
    createdAt: 0,
  }), { mode: 0o600 });
  const old = new Date(Date.now() - 2_000);
  utimesSync(path, old, old);

  const release = await acquireProfileCommandLock('stale', { timeoutMs: 100 });
  assert.notEqual(JSON.parse(readFileSync(path, 'utf8')).token, 'dead-owner');
  release();
  assert.equal(existsSync(path), false);
});
