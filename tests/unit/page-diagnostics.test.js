import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canvasSnapshotHint,
  fieldChangeSummary,
  formatFrameEvalResults,
  parseAgentBrowserBox,
  parseAgentBrowserValueLength,
  parseKeyChord,
  pickFocusedTarget,
} from '../../lib/page-diagnostics.js';

test('key chords preserve macOS modifiers and printable key metadata', () => {
  assert.deepEqual(parseKeyChord('Meta+a'), {
    key: 'a',
    code: 'KeyA',
    keyCode: 65,
    modifiers: 4,
    text: '',
  });
  assert.deepEqual(parseKeyChord('Shift+A'), {
    key: 'A',
    code: 'KeyA',
    keyCode: 65,
    modifiers: 8,
    text: 'A',
  });
  assert.equal(parseKeyChord('Delete').keyCode, 46);
  assert.throws(() => parseKeyChord('Meta+Hyper+a'), /unknown modifier/i);
});

test('the deepest focused frame wins and body focus stays explicit', () => {
  const focused = pickFocusedTarget([
    { frameId: 'top', depth: 0, sessionId: 's1', url: 'https://app.test', focus: { tag: 'iframe', active: true } },
    { frameId: 'child', depth: 1, sessionId: 's2', url: 'https://frame.test', focus: { tag: 'input', type: 'text', name: 'State', active: true } },
  ]);
  assert.equal(focused.frameId, 'child');
  assert.equal(focused.focus.name, 'State');

  const body = pickFocusedTarget([
    { frameId: 'top', depth: 0, sessionId: 's1', url: 'https://canvas.test', focus: { tag: 'body', active: true, documentFocused: true } },
  ]);
  assert.equal(body.focus.tag, 'body');
  assert.equal(pickFocusedTarget([]), null);
});

test('frame eval output retains each frame result and each frame error', () => {
  const output = JSON.parse(formatFrameEvalResults([
    { frameId: 'top', url: 'https://app.test', value: 3 },
    { frameId: 'child', url: 'https://frame.test', error: 'ReferenceError: missing' },
  ]));
  assert.equal(output.frames.length, 2);
  assert.equal(output.frames[0].value, 3);
  assert.match(output.frames[1].error, /ReferenceError/);
});

test('field reporting exposes only lengths and replacement semantics', () => {
  assert.equal(parseAgentBrowserValueLength('{"success":true,"data":{"value":"secret"}}'), 6);
  assert.equal(parseAgentBrowserValueLength('{"success":false}'), null);
  assert.deepEqual(
    parseAgentBrowserBox('{"success":true,"data":{"box":{"x":10,"y":20,"width":30,"height":40}}}'),
    { x: 10, y: 20, width: 30, height: 40 }
  );
  assert.equal(
    fieldChangeSummary('replace', 12, 6),
    'replaced field content (length 12 -> 6; values hidden)'
  );
  assert.doesNotMatch(fieldChangeSummary('append', 6, 12), /secret/);
});

test('large canvas pages receive the screenshot fallback without claiming the page is empty', () => {
  assert.match(canvasSnapshotHint({ coverage: 0.72, width: 1200, height: 700 }), /screenshot/i);
  assert.equal(canvasSnapshotHint({ coverage: 0.08, width: 100, height: 100 }), null);
});
