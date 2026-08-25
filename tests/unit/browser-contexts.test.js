import { test } from 'node:test';
import assert from 'node:assert/strict';
import { livePageContextIds } from '../../lib/browser-contexts.js';

test('several windows in one browser context are not a profile split', () => {
  const targets = [
    { type: 'page', targetId: 'one', browserContextId: 'context-a' },
    { type: 'page', targetId: 'two', browserContextId: 'context-a' },
    { type: 'service_worker', targetId: 'worker', browserContextId: 'context-b' },
  ];

  assert.deepEqual(livePageContextIds(targets), ['context-a']);
});

test('page targets in two browser contexts are a profile split', () => {
  const targets = [
    { type: 'page', targetId: 'one', browserContextId: 'context-a' },
    { type: 'page', targetId: 'two', browserContextId: 'context-b' },
  ];

  assert.deepEqual(livePageContextIds(targets), ['context-a', 'context-b']);
});

test('an omitted browserContextId still denotes one default context', () => {
  const targets = [
    { type: 'page', targetId: 'one' },
    { type: 'page', targetId: 'two' },
  ];

  assert.deepEqual(livePageContextIds(targets), ['default']);
});
