import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsForBlocker,
  addBlockerPolicy,
  blockedLaneResult,
  blockersForLane,
  laneCommandNeedsClearUI,
  newBlockers,
  parseUIArgs,
} from '../../lib/ui.js';

test('UI status is read-only and rejects unimplemented actions', () => {
  assert.deepEqual(parseUIArgs([]), { action: 'status' });
  assert.deepEqual(parseUIArgs(['status']), { action: 'status' });
  assert.match(parseUIArgs(['show']).error, /expected status/);
  assert.match(parseUIArgs(['status', '--json']).error, /unknown ui argument/);
});

test('blocker policy makes showing UI an agent choice', () => {
  const blocker = addBlockerPolicy(
    { id: 'window-42', kind: 'browser-modal', blocking: true },
    'research'
  );
  assert.deepEqual(blocker.actions, ['wait', 'show', 'abort-by-navigation']);
  assert.equal(blocker.showCommand, 'web-plane -s=research show');
  assert.deepEqual(
    actionsForBlocker({ kind: 'native-panel', subtype: 'save' }),
    ['wait', 'accept', 'cancel', 'show']
  );
});

test('unknown agent-browser commands fail closed while inspection and recovery stay available', () => {
  for (const command of ['snapshot', 'screenshot', 'eval', 'goto', 'reload', 'tab']) {
    assert.equal(laneCommandNeedsClearUI([command]), false, command);
  }
  for (const command of ['click', 'fill', 'type', 'press', 'hover', 'future-input-command']) {
    assert.equal(laneCommandNeedsClearUI([command]), true, command);
  }
});

test('post-command comparison reports only newly appeared blockers', () => {
  const existing = { id: 'window-1', kind: 'browser-modal' };
  const appeared = { id: 'panel-2', kind: 'native-panel' };
  assert.deepEqual(newBlockers([existing], [existing, appeared]), [appeared]);
  assert.deepEqual(newBlockers([], [existing]), [existing]);
});

test('a tab blocker gates only its owning lane once ownership is known', () => {
  const owned = { id: 'window-a', scope: 'tab', ownerLane: 'lane-a' };
  const unknown = { id: 'window-b', scope: 'tab' };
  const appWide = { id: 'panel-a', scope: 'app' };
  assert.deepEqual(blockersForLane([owned, unknown, appWide], 'lane-a'), [
    owned,
    unknown,
    appWide,
  ]);
  assert.deepEqual(blockersForLane([owned, unknown, appWide], 'lane-b'), [
    unknown,
    appWide,
  ]);
});

test('lane blocker errors distinguish a refused command from a command that created UI', () => {
  const blocker = { id: 'window-42', kind: 'browser-modal' };
  const before = blockedLaneResult('click', blocker);
  assert.equal(before.error.code, 'UI_BLOCKED');
  assert.equal(before.error.commandExecuted, false);
  const after = blockedLaneResult('click', blocker, { commandExecuted: true });
  assert.equal(after.error.code, 'UI_BLOCKED_AFTER_COMMAND');
  assert.equal(after.error.commandExecuted, true);
});
