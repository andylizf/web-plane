import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

// paths are derived from $HOME at import time, so the fake home has to be in
// place before lib/config.js is ever loaded.
const HOME = makeTmpDir('sign-home');
process.env.HOME = HOME;
process.on('exit', () => removeTmpDir(HOME));

const { selectStaleClones } = await import('../../lib/sign.js');

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** A clone directory as readdir+stat would report it, aged in hours. */
const clone = (name, hoursOld) => ({ name, mtimeMs: NOW - hoursOld * HOUR });

test('old clones are selected once the newest are spared', () => {
  const stale = selectStaleClones(
    [clone('code_sign_clone.aaa', 10), clone('code_sign_clone.bbb', 8), clone('code_sign_clone.ccc', 6)],
    { keepRecent: 1, now: NOW }
  );
  // ccc is newest and kept; the other two are old enough to go.
  assert.deepEqual(stale, ['code_sign_clone.bbb', 'code_sign_clone.aaa']);
});

test('the newest clones are kept because a running browser is holding one', () => {
  const entries = [clone('code_sign_clone.aaa', 10), clone('code_sign_clone.bbb', 9)];
  assert.deepEqual(selectStaleClones(entries, { keepRecent: 2, now: NOW }), []);
});

test('a clone younger than the age floor survives a concurrent launch', () => {
  // A second session launching right now has just created one. Age, not just
  // rank, has to protect it: with keepRecent alone a burst of launches would
  // push it out of the kept window while it was still being written.
  const entries = [
    clone('code_sign_clone.old1', 10),
    clone('code_sign_clone.old2', 9),
    clone('code_sign_clone.old3', 8),
    clone('code_sign_clone.fresh', 0),
  ];
  // keepRecent is set to 0 deliberately, so the age floor is the only thing that
  // can save `fresh`. With keepRecent doing the work the assertion would pass
  // whether or not minAgeMs were honoured.
  const stale = selectStaleClones(entries, { keepRecent: 0, minAgeMs: HOUR, now: NOW });
  assert.ok(!stale.includes('code_sign_clone.fresh'));
  assert.deepEqual(stale.sort(), ['code_sign_clone.old1', 'code_sign_clone.old2', 'code_sign_clone.old3']);
});

test('nothing is selected when the directory is empty', () => {
  assert.deepEqual(selectStaleClones([], { now: NOW }), []);
});

test('the input array is not mutated', () => {
  const entries = [clone('code_sign_clone.aaa', 1), clone('code_sign_clone.bbb', 10)];
  const before = entries.map((e) => e.name);
  selectStaleClones(entries, { keepRecent: 0, now: NOW });
  assert.deepEqual(
    entries.map((e) => e.name),
    before,
    'sorting must not reorder the caller’s array'
  );
});
