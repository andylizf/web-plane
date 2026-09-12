import assert from 'node:assert/strict';
import test from 'node:test';

const { laneFocusDecision, laneReapDecision, nextLaneSweepDelay } = await import(
  `../../lib/lane-lifecycle.js?test=${Date.now()}`
);

const NOW = Date.parse('2026-08-29T02:00:00.000Z');
const TTL = 24 * 60 * 60 * 1000;

function candidate(overrides = {}) {
  return {
    state: {
      lane: 'old-task',
      targetId: 'TARGET',
      lastCommandAt: '2026-08-28T01:00:00.000Z',
      keep: false,
    },
    nowMs: NOW,
    ttlMs: TTL,
    targetId: 'TARGET',
    ...overrides,
  };
}

test('an expired lane with the expected target is eligible', () => {
  assert.deepEqual(laneReapDecision(candidate()), {
    eligible: true,
    reason: 'hard-timeout',
    ageMs: 25 * 60 * 60 * 1000,
  });
});

test('a recent command renews the hard idle deadline', () => {
  assert.equal(laneReapDecision(candidate({
    state: { ...candidate().state, lastCommandAt: '2026-08-29T01:30:00.000Z' },
  })).reason, 'not-idle');
});

test('target mismatch and invalid timing fail closed', () => {
  assert.equal(laneReapDecision(candidate({ targetId: 'OTHER' })).reason, 'target-mismatch');
  assert.equal(laneReapDecision(candidate({
    state: { ...candidate().state, lastCommandAt: 'not-a-time' },
  })).reason, 'inspection-unknown');
});

test('page activity and legacy keep metadata never bypass the hard timeout', () => {
  const decision = laneReapDecision(candidate({
    state: { ...candidate().state, keep: true },
    hidden: false,
    frames: [{ value: { dirty: true, mediaPlaying: true, beforeUnload: true } }],
    activeRequests: 1,
    activeDownloads: 1,
  }));
  assert.equal(decision.reason, 'hard-timeout');
  assert.equal(decision.eligible, true);
});

test('the monitor schedules at the lease deadline instead of one interval late', () => {
  const state = { lastCommandAt: '2026-08-28T02:01:00.000Z' };
  assert.equal(nextLaneSweepDelay({
    state,
    nowMs: NOW,
    ttlMs: TTL,
    intervalMs: 60 * 60 * 1000,
  }), 60_000);
  assert.equal(nextLaneSweepDelay({
    state: { lastCommandAt: '2026-08-28T01:00:00.000Z' },
    nowMs: NOW,
    ttlMs: TTL,
    intervalMs: 60 * 60 * 1000,
  }), 25);
});

const FOCUS_IDLE = 5 * 60 * 1000;

test('a lane commanded within the idle window keeps focus until the window ends', () => {
  assert.deepEqual(
    laneFocusDecision({
      state: { lastCommandAt: new Date(NOW - 60_000).toISOString() },
      nowMs: NOW,
      idleMs: FOCUS_IDLE,
    }),
    { hold: true, releaseInMs: FOCUS_IDLE - 60_000 }
  );
});

test('a lane idle past the window releases focus', () => {
  assert.deepEqual(
    laneFocusDecision({
      state: { lastCommandAt: new Date(NOW - FOCUS_IDLE).toISOString() },
      nowMs: NOW,
      idleMs: FOCUS_IDLE,
    }),
    { hold: false, releaseInMs: null }
  );
});

test('a lane with no command record does not hold focus', () => {
  assert.deepEqual(
    laneFocusDecision({ state: null, nowMs: NOW, idleMs: FOCUS_IDLE }),
    { hold: false, releaseInMs: null }
  );
  assert.deepEqual(
    laneFocusDecision({ state: { lastCommandAt: 'garbage' }, nowMs: NOW, idleMs: FOCUS_IDLE }),
    { hold: false, releaseInMs: null }
  );
});
