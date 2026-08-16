import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_AGENT_BROWSER } from '../../lib/config.js';
import { activeTargetId } from '../../lib/cdp.js';
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
    { home, env: { PATH: `${bin}:${process.env.PATH}` } }
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`below the required ${MIN_AGENT_BROWSER.replace(/\./g, '\\.')}`));
  assert.match(result.stderr, /strict session-to-tab binding/);
  assert.doesNotMatch(result.all, /Failed to start hidden session/);
});
