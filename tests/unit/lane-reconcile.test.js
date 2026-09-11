import assert from 'node:assert/strict';
import test from 'node:test';

const { planLaneReconciliation } = await import(`../../lib/lane-reconcile.js?test=${Date.now()}`);

const page = (id, url, title = '') => ({ id, url, title });
const lane = (name, overrides = {}) => ({
  lane: name,
  session: 'main',
  port: 1,
  targetId: `T-${name}`,
  url: `https://example.com/${name}`,
  title: name,
  lastCommandAt: '2026-09-10T00:00:00.000Z',
  ...overrides,
});
const noneAlive = () => false;

test('a lane whose monitor is alive is left alone and keeps its tab', () => {
  const actions = planLaneReconciliation({
    states: [lane('a')],
    targets: [page('T-a', 'https://example.com/a', 'a')],
    monitorAlive: () => true,
    fresh: true,
  });
  assert.deepEqual(actions, []);
});

test('a dead monitor with its tab still present is re-armed on that tab', () => {
  const actions = planLaneReconciliation({
    states: [lane('a')],
    targets: [page('T-a', 'https://example.com/a', 'a')],
    monitorAlive: noneAlive,
    fresh: false,
  });
  assert.deepEqual(actions, [{ action: 'rearm', lane: 'a', targetId: 'T-a', reason: 'target-present' }]);
});

test('a dead monitor whose tab was restored under a new id is re-armed on the restored tab', () => {
  const actions = planLaneReconciliation({
    states: [lane('a')],
    targets: [page('NEW', 'https://example.com/a', 'a')],
    monitorAlive: noneAlive,
    fresh: true,
  });
  assert.deepEqual(actions, [{
    action: 'rearm', lane: 'a', targetId: 'NEW', url: 'https://example.com/a', title: 'a', tabIndex: 0,
    reason: 'restored-target',
  }]);
});

test('a dead monitor with no tab left is forgotten', () => {
  const actions = planLaneReconciliation({
    states: [lane('a')],
    targets: [page('X', 'https://other.example/')],
    monitorAlive: noneAlive,
    fresh: false,
  });
  assert.deepEqual(actions, [{ action: 'forget', lane: 'a', reason: 'url-not-restored' }]);
});

test('look-alike restored tabs are neither bound nor closed', () => {
  const actions = planLaneReconciliation({
    states: [lane('a')],
    targets: [page('P', 'https://example.com/a', 'a'), page('Q', 'https://example.com/a', 'a')],
    monitorAlive: noneAlive,
    fresh: true,
  });
  assert.deepEqual(actions, [
    { action: 'unresolved', lane: 'a', reason: 'multiple-url-matches', candidateCount: 2 },
  ]);
});

test('a fresh launch closes restored tabs no lane records, never launch pages', () => {
  const actions = planLaneReconciliation({
    states: [lane('a')],
    targets: [
      page('T-a', 'https://example.com/a', 'a'),
      page('O', 'https://bank.example/logout'),
      page('B', 'about:blank'),
      page('N', 'chrome://newtab/'),
    ],
    monitorAlive: () => true,
    fresh: true,
  });
  assert.deepEqual(actions, [{ action: 'close-orphan', targetId: 'O', url: 'https://bank.example/logout' }]);
});

test('a reused browser keeps unowned tabs', () => {
  const actions = planLaneReconciliation({
    states: [],
    targets: [page('O', 'https://bank.example/logout')],
    monitorAlive: noneAlive,
    fresh: false,
  });
  assert.deepEqual(actions, []);
});

test('closing every page would exit Chrome, so one orphan is kept', () => {
  const actions = planLaneReconciliation({
    states: [],
    targets: [page('O1', 'https://a.example/'), page('O2', 'https://b.example/')],
    monitorAlive: noneAlive,
    fresh: true,
  });
  assert.deepEqual(actions, [{ action: 'close-orphan', targetId: 'O2', url: 'https://b.example/' }]);
});

test('a tab claimed by one lane is not offered to the next lane or closed as an orphan', () => {
  const actions = planLaneReconciliation({
    states: [lane('a', { targetId: 'OLD-a' }), lane('b', { targetId: 'OLD-b', url: 'https://example.com/a', title: 'a' })],
    targets: [page('NEW', 'https://example.com/a', 'a')],
    monitorAlive: noneAlive,
    fresh: true,
  });
  assert.deepEqual(actions, [
    { action: 'rearm', lane: 'a', targetId: 'NEW', url: 'https://example.com/a', title: 'a', tabIndex: 0, reason: 'restored-target' },
    { action: 'forget', lane: 'b', reason: 'url-not-restored' },
  ]);
});
