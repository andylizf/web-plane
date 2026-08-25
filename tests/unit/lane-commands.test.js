import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCoveredClickFailure,
  laneHelp,
  translateLaneCommand,
} from '../../lib/lane-commands.js';

test('plain type replaces existing content while --append keeps upstream type semantics', () => {
  assert.deepEqual(translateLaneCommand(['type', 'e4', 'hello']), {
    args: ['fill', 'e4', 'hello'],
    operation: 'replace',
    wait: null,
  });
  assert.deepEqual(translateLaneCommand(['type', 'e4', 'hello', '--append']), {
    args: ['type', 'e4', 'hello'],
    operation: 'append',
    wait: null,
  });
});

test('clear is an iframe-safe empty fill and close is tab-scoped', () => {
  assert.deepEqual(translateLaneCommand(['clear', 'e9']), {
    args: ['fill', 'e9', ''],
    operation: 'clear',
    wait: null,
  });
  assert.deepEqual(translateLaneCommand(['close']), {
    args: ['tab', 'close'],
    operation: 'close-lane',
    wait: null,
  });
});

test('navigation waits for network idle by default and accepts explicit overrides', () => {
  assert.deepEqual(translateLaneCommand(['navigate', 'https://example.com']), {
    args: ['navigate', 'https://example.com'],
    operation: 'navigate',
    wait: ['wait', '--load', 'networkidle', '--timeout', '15000'],
  });
  assert.deepEqual(
    translateLaneCommand([
      'goto',
      'https://example.com',
      '--wait-for',
      '#ready',
      '--timeout',
      '4500',
    ]),
    {
      args: ['goto', 'https://example.com'],
      operation: 'navigate',
      wait: ['wait', '#ready', '--timeout', '4500'],
    }
  );
  assert.deepEqual(translateLaneCommand(['open', 'https://example.com', '--no-wait']), {
    args: ['open', 'https://example.com'],
    operation: 'navigate',
    wait: null,
  });
});

test('invalid web-plane lane flags fail before reaching agent-browser', () => {
  assert.throws(
    () => translateLaneCommand(['navigate', 'https://example.com', '--timeout', 'soon']),
    /--timeout expects milliseconds/
  );
  assert.throws(() => translateLaneCommand(['type', 'e1', 'x', '--append', '--append']), /once/);
  assert.throws(() => translateLaneCommand(['clear']), /clear <selector>/);
});

test('covered click failures are recognized narrowly', () => {
  assert.equal(
    isCoveredClickFailure("Element 'e1' is covered by <header> at its click point"),
    true
  );
  assert.equal(isCoveredClickFailure('Unknown ref: e1'), false);
});

test('lane help exposes the safe and diagnostic paths hidden by top-level help', () => {
  const help = laneHelp('0.3.4');
  for (const expected of [
    'fill <selector> <text>',
    'type <selector> <text> --append',
    'find role <role>',
    'scrollintoview <selector>',
    'wait --load networkidle',
    'console',
    'errors',
    'netlog --failed',
    'eval --all-frames',
    'close',
  ]) {
    assert.match(help, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
