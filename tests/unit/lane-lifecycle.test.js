import assert from 'node:assert/strict';
import test from 'node:test';

const {
  LIFECYCLE_PROBE_EXPRESSION,
  LIFECYCLE_TRACKER_SCRIPT,
  laneReapDecision,
} = await import(`../../lib/lane-lifecycle.js?test=${Date.now()}`);

const NOW = Date.parse('2026-08-29T02:00:00.000Z');
const TTL = 24 * 60 * 60 * 1000;

function safeFrame(overrides = {}) {
  return {
    frameId: 'top',
    value: {
      tracked: true,
      dirty: false,
      mediaPlaying: false,
      beforeUnloadKnown: true,
      beforeUnload: false,
      ...overrides,
    },
  };
}

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
    hidden: true,
    targetId: 'TARGET',
    frames: [safeFrame()],
    activeRequests: 0,
    activeDownloads: 0,
    ...overrides,
  };
}

test('only a known clean hidden idle lane is eligible', () => {
  assert.deepEqual(laneReapDecision(candidate()), {
    eligible: true,
    reason: 'eligible',
    ageMs: 25 * 60 * 60 * 1000,
  });
});

test('recent commands, keep, and visibility each block reclamation', () => {
  assert.equal(laneReapDecision(candidate({
    state: { ...candidate().state, lastCommandAt: '2026-08-29T01:30:00.000Z' },
  })).reason, 'not-idle');
  assert.equal(laneReapDecision(candidate({
    state: { ...candidate().state, keep: true },
  })).reason, 'explicit-keep');
  assert.equal(laneReapDecision(candidate({ hidden: false })).reason, 'session-visible');
  assert.equal(laneReapDecision(candidate({ hidden: null })).reason, 'hidden-state-unknown');
});

test('target mismatch and incomplete frame evidence fail closed', () => {
  assert.equal(laneReapDecision(candidate({ targetId: 'OTHER' })).reason, 'target-mismatch');
  assert.equal(laneReapDecision(candidate({ frames: [] })).reason, 'inspection-unknown');
  assert.equal(laneReapDecision(candidate({
    frames: [{ frameId: 'top', error: 'context gone' }],
  })).reason, 'inspection-unknown');
  assert.equal(laneReapDecision(candidate({
    frames: [safeFrame({ tracked: false })],
  })).reason, 'inspection-unknown');
  assert.equal(laneReapDecision(candidate({
    frames: [safeFrame({ beforeUnloadKnown: false })],
  })).reason, 'inspection-unknown');
  assert.equal(laneReapDecision(candidate({
    state: { ...candidate().state, lastCommandAt: 'not-a-time' },
  })).reason, 'inspection-unknown');
});

test('unsaved input, media, requests, and downloads each protect the lane', () => {
  assert.equal(laneReapDecision(candidate({
    frames: [safeFrame({ dirty: true })],
  })).reason, 'unsubmitted-input');
  assert.equal(laneReapDecision(candidate({
    frames: [safeFrame({ mediaPlaying: true })],
  })).reason, 'media-playing');
  assert.equal(laneReapDecision(candidate({
    frames: [safeFrame({ beforeUnload: true })],
  })).reason, 'beforeunload-registered');
  assert.equal(laneReapDecision(candidate({ activeRequests: 1 })).reason, 'network-active');
  assert.equal(laneReapDecision(candidate({ activeDownloads: 1 })).reason, 'download-active');
});

test('tracker and probe expose booleans without form or media content', () => {
  assert.match(LIFECYCLE_TRACKER_SCRIPT, /Symbol\.for/);
  assert.match(LIFECYCLE_TRACKER_SCRIPT, /addEventListener/);
  assert.match(LIFECYCLE_TRACKER_SCRIPT, /reset[\s\S]+setTimeout/);
  assert.match(LIFECYCLE_TRACKER_SCRIPT, /submit[\s\S]+setTimeout/);
  assert.match(LIFECYCLE_PROBE_EXPRESSION, /mediaPlaying/);
  assert.match(LIFECYCLE_PROBE_EXPRESSION, /getEventListeners/);
  assert.doesNotMatch(LIFECYCLE_PROBE_EXPRESSION, /\.value|innerText|textContent/);
});
