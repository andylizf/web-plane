import assert from 'node:assert/strict';
import test from 'node:test';

import { publicTarget, resolveDiscardReplacement, resolveRestoredTarget } from '../../lib/lane-recovery.js';

const targets = [
  { id: 'A', title: 'Application', url: 'https://portal.example/form?step=3#address' },
  { id: 'B', title: 'Inbox', url: 'https://mail.example/inbox' },
];

test('a unique exact URL restores the original Chrome target', () => {
  const result = resolveRestoredTarget({
    url: 'https://portal.example/form?step=3#address',
    title: 'Application',
    tabIndex: 0,
  }, targets);

  assert.equal(result.status, 'matched');
  assert.equal(result.target.id, 'A');
});

test('title disambiguates restored tabs with the same URL', () => {
  const result = resolveRestoredTarget({
    url: 'https://portal.example/form',
    title: 'Second application',
  }, [
    { id: 'A', title: 'First application', url: 'https://portal.example/form' },
    { id: 'B', title: 'Second application', url: 'https://portal.example/form' },
  ]);

  assert.equal(result.status, 'matched');
  assert.equal(result.target.id, 'B');
});

test('stored index never guesses between indistinguishable restored tabs', () => {
  const duplicate = [
    { id: 'A', title: 'Same', url: 'https://portal.example/form' },
    { id: 'B', title: 'Same', url: 'https://portal.example/form' },
  ];
  const sameUrl = resolveRestoredTarget({
    url: 'https://portal.example/form',
    title: 'Same',
    tabIndex: 1,
  }, duplicate);
  assert.equal(sameUrl.status, 'ambiguous');

  const wrongUrl = resolveRestoredTarget({
    url: 'https://portal.example/missing',
    tabIndex: 1,
  }, duplicate);
  assert.equal(wrongUrl.status, 'missing');
});

test('duplicate URL and title without a matching index stays ambiguous', () => {
  const result = resolveRestoredTarget({
    url: 'https://portal.example/form',
    title: 'Same',
  }, [
    { id: 'A', title: 'Same', url: 'https://portal.example/form' },
    { id: 'B', title: 'Same', url: 'https://portal.example/form' },
  ]);

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});

test('a legacy lane without an observed URL is never guessed by index', () => {
  const result = resolveRestoredTarget({ title: 'Inbox', tabIndex: 1 }, targets);
  assert.equal(result.status, 'missing');
  assert.equal(result.reason, 'no-saved-url');
});

test('public target diagnostics strip query strings and fragments', () => {
  assert.deepEqual(publicTarget(targets[0], 0), {
    index: 0,
    title: 'Application',
    url: 'https://portal.example/form',
  });
});

test('a discarded tab is followed to its placeholder, never back to the old target', () => {
  const saved = { targetId: 'OLD', url: 'https://mail.example/inbox', title: 'Inbox' };
  const live = [
    { id: 'OLD', title: 'Inbox', url: 'https://mail.example/inbox' },
    { id: 'NEW', title: 'Inbox', url: 'https://mail.example/inbox' },
  ];
  const result = resolveDiscardReplacement(saved, live, 'OLD');
  assert.equal(result.status, 'matched');
  assert.equal(result.target.id, 'NEW');
  assert.equal(resolveDiscardReplacement(saved, [live[0]], 'OLD').status, 'missing');
});
