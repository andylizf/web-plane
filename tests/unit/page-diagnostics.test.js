import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateSnapshotFormStates,
  canvasSnapshotHint,
  fieldReadbackResult,
  formatFrameEvalResults,
  parseAgentBrowserBox,
  parseAgentBrowserValue,
  parseKeyChord,
  snapshotFormControls,
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

test('field reads retain the complete value and prove exact write semantics', () => {
  assert.equal(parseAgentBrowserValue('{"success":true,"data":{"value":"secret"}}'), 'secret');
  assert.equal(parseAgentBrowserValue('{"success":true,"data":{"value":""}}'), '');
  assert.equal(parseAgentBrowserValue('{"success":false}'), null);
  assert.deepEqual(
    parseAgentBrowserBox('{"success":true,"data":{"box":{"x":10,"y":20,"width":30,"height":40}}}'),
    { x: 10, y: 20, width: 30, height: 40 }
  );

  assert.deepEqual(fieldReadbackResult({
    operation: 'replace', before: 'old', input: 'new', after: 'new', password: false,
  }), {
    ok: true,
    expected: 'new',
    actual: 'new',
    message: 'verified field value "new"',
  });
  assert.equal(fieldReadbackResult({
    operation: 'append', before: 'old', input: '+new', after: 'old+new', password: false,
  }).ok, true);
  assert.equal(fieldReadbackResult({
    operation: 'clear', before: 'old', input: '', after: '', password: false,
  }).message, 'verified field value ""');

  const mismatch = fieldReadbackResult({
    operation: 'replace', before: 'old', input: 'right', after: 'wrong', password: false,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /expected "right", read "wrong"/);

  const password = fieldReadbackResult({
    operation: 'replace', before: 'old-secret', input: 'new-secret', after: 'new-secret', password: true,
  });
  assert.equal(password.ok, true);
  assert.equal(password.message, 'verified password field value <10 chars>');
  assert.doesNotMatch(password.message, /secret/);

  const unreadable = fieldReadbackResult({
    operation: 'replace', before: 'old', input: 'new', after: null, password: false,
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.message, /could not read field value after write/);
});

test('snapshot form state uses existing refs and makes empty values explicit', () => {
  const snapshot = [
    '- textbox "Username" [required, ref=e1]: stale',
    '- textbox "Password" [required, ref=e2]',
    '- textbox "Empty" [ref=e3]',
    '- checkbox "Remember" [checked=false, ref=e4]',
    '- combobox "Country" [ref=e5]',
    '- button "Save" [ref=e6]',
  ].join('\n');
  assert.deepEqual(snapshotFormControls(snapshot), [
    { role: 'textbox', ref: 'e1' },
    { role: 'textbox', ref: 'e2' },
    { role: 'textbox', ref: 'e3' },
    { role: 'checkbox', ref: 'e4' },
    { role: 'combobox', ref: 'e5' },
  ]);

  const annotated = annotateSnapshotFormStates(snapshot, [
    { ref: 'e1', kind: 'value', value: 'agent', password: false },
    { ref: 'e2', kind: 'value', value: 'top-secret', password: true },
    { ref: 'e3', kind: 'value', value: '', password: false },
    { ref: 'e4', kind: 'checked', checked: true },
    { ref: 'e5', kind: 'value', value: 'United States', password: false },
  ]);
  assert.match(annotated, /textbox "Username" \[required, ref=e1, value="agent"\]/);
  assert.doesNotMatch(annotated, /: stale/);
  assert.match(annotated, /textbox "Password" \[required, ref=e2, value=<10 chars>\]/);
  assert.doesNotMatch(annotated, /top-secret/);
  assert.match(annotated, /textbox "Empty" \[ref=e3, value=""\]/);
  assert.match(annotated, /checkbox "Remember" \[checked=true, ref=e4\]/);
  assert.match(annotated, /combobox "Country" \[ref=e5, value="United States"\]/);
  assert.match(annotated, /button "Save" \[ref=e6\]/);
});

test('large canvas pages receive the screenshot fallback without claiming the page is empty', () => {
  assert.match(canvasSnapshotHint({ coverage: 0.72, width: 1200, height: 700 }), /screenshot/i);
  assert.equal(canvasSnapshotHint({ coverage: 0.08, width: 100, height: 100 }), null);
});
