import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_AGENT_BROWSER } from '../../lib/config.js';
import {
  activeTargetId,
  isCdpVersionPayload,
  parseAgentBrowserPageErrors,
} from '../../lib/cdp.js';
import { runCli } from '../helpers/cli.js';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

let root;
before(() => (root = makeTmpDir('lane')));
after(() => root && removeTmpDir(root));

test('reads only the active stable target id from agent-browser JSON', () => {
  const listing = JSON.stringify({
    success: true,
    data: {
      tabs: [
        { active: false, tabId: 't1', targetId: 'TARGET-A' },
        { active: true, tabId: 't2', targetId: 'TARGET-B' },
      ],
    },
  });
  assert.equal(activeTargetId(listing), 'TARGET-B');
  assert.equal(activeTargetId('{not-json'), null);
  assert.equal(activeTargetId(JSON.stringify({ success: true, data: { tabs: [] } })), null);
});

test('CDP health rejects an HTTP success carrying HTML or unrelated JSON', () => {
  assert.equal(isCdpVersionPayload('<!DOCTYPE html>'), false);
  assert.equal(isCdpVersionPayload({ status: 'ok' }), false);
  assert.equal(isCdpVersionPayload({ webSocketDebuggerUrl: 'https://example.test' }), false);
  assert.equal(
    isCdpVersionPayload({ webSocketDebuggerUrl: 'ws://127.0.0.1:49152/devtools/browser/id' }),
    true
  );
});

test('reads the persistent page-error buffer from agent-browser JSON', () => {
  const errors = parseAgentBrowserPageErrors(JSON.stringify({
    success: true,
    data: {
      errors: [
        { text: 'Error: detached rejection', url: null, line: 0, column: 12 },
        { text: 'Error: delayed throw', url: 'about:blank', line: 1, column: 2 },
      ],
    },
  }));

  assert.deepEqual(errors, [
    { text: 'Error: detached rejection', url: null, line: 0, column: 12 },
    { text: 'Error: delayed throw', url: 'about:blank', line: 1, column: 2 },
  ]);
  assert.deepEqual(
    parseAgentBrowserPageErrors(JSON.stringify({ success: true, data: { errors: [] } })),
    []
  );
  assert.throws(() => parseAgentBrowserPageErrors('{"success":true}'), /no structured/);
});

test('a lane without a web-plane mapping cannot launch an unrelated browser', () => {
  const home = join(root, 'unmapped-home');
  mkdirSync(home, { recursive: true });
  const result = runCli(['lane', 'unmapped', 'snapshot'], { home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /has no web-plane session mapping/);
  assert.match(result.stderr, /attach --as unmapped/);
});

test(`attach rejects agent-browser below ${MIN_AGENT_BROWSER} before launching Chrome`, () => {
  const home = join(root, 'old-version-home');
  const bin = join(root, 'old-version-bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'agent-browser');
  writeFileSync(fake, '#!/bin/sh\nprintf "agent-browser 0.33.2\\n"\n');
  chmodSync(fake, 0o755);

  const result = runCli(
    ['-s=profile', 'attach', '--as', 'old-lane', 'https://example.com'],
    { home, env: { WEB_PLANE_TEST_AGENT_BROWSER_BIN: fake } }
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`below the required ${MIN_AGENT_BROWSER.replace(/\./g, '\\.')}`));
  assert.match(result.stderr, /strict session-to-tab binding/);
  assert.doesNotMatch(result.all, /Failed to start hidden session/);
});
