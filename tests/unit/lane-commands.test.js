import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCoveredClickFailure,
  laneHelp,
  parseSemanticFind,
  resolveSnapshotRole,
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

test('force click, all-frame eval, and key commands stay explicit at the lane boundary', () => {
  assert.deepEqual(translateLaneCommand(['click', 'e3', '--force']), {
    args: ['click', 'e3'],
    operation: 'force-click',
    wait: null,
  });
  assert.deepEqual(translateLaneCommand(['eval', '--all-frames', 'document.title']), {
    args: ['eval', 'document.title'],
    operation: 'eval-all-frames',
    wait: null,
  });
  assert.deepEqual(translateLaneCommand(['key', 'Meta+a']), {
    args: ['press', 'Meta+a'],
    operation: 'key',
    wait: null,
  });
  assert.throws(() => translateLaneCommand(['click', 'e3', '--force', '--force']), /once/);
});

test('semantic role lookup resolves a fresh iframe-visible snapshot ref', () => {
  const plan = parseSemanticFind([
    'find', 'role', 'textbox', 'fill', 'TX', '--name', 'State', '--exact',
  ]);
  assert.deepEqual(plan, {
    role: 'textbox', name: 'State', exact: true, action: 'fill', text: 'TX',
  });
  assert.deepEqual(
    resolveSnapshotRole(
      '- iframe "Nested form"\n  - textbox "State" [required, ref=e62]',
      plan
    ),
    { ref: 'e62', role: 'textbox', name: 'State' }
  );
  assert.equal(
    resolveSnapshotRole('- textbox "Statement" [ref=e2]', plan),
    null,
  );
  assert.equal(
    translateLaneCommand(['find', 'role', 'button', '--name', 'Save']).operation,
    'semantic-find'
  );
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
    'current form-control state',
    'require an exact value match',
    'password output is length-only',
    'close',
  ]) {
    assert.match(help, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
