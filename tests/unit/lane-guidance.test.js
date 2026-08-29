import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { REPO_ROOT } from '../helpers/tmpdir.js';

const guidanceFiles = [
  'README.md',
  'SKILL.md',
  'plugins/browser/skills/browser/SKILL.md',
];

test('lane guidance explains the shared-profile critical section and hard timeout', () => {
  for (const relative of guidanceFiles) {
    const text = readFileSync(`${REPO_ROOT}/${relative}`, 'utf8');
    assert.match(text, /critical\s+section/i, `${relative} omits the lock scope`);
    assert.match(text, /waits\s+up\s+to\s+30\s+seconds/i, `${relative} omits the queue wait limit`);
    assert.match(text, /ProcessSingleton/, `${relative} omits Chrome's instance ownership`);
    assert.match(
      text,
      /command lock is separate from Chrome's `ProcessSingleton`/i,
      `${relative} conflates the command lock with Chrome's instance ownership`
    );
    assert.match(text, /hard\s+idle\s+timeout/i, `${relative} omits the hard timeout`);
    assert.match(
      text,
      /retried\s+rather\s+than\s+reported\s+as\s+success/i,
      `${relative} overpromises deadline cleanup when the critical section or cleanup is blocked`
    );
    assert.doesNotMatch(
      text,
      /excluded from the 24-hour backstop/i,
      `${relative} still promises an unbounded keep exemption`
    );
    assert.doesNotMatch(
      text,
      /web-plane lane[^\n]+\b(?:keep|unkeep)\b/i,
      `${relative} still tells agents to use removed lifecycle commands`
    );
  }
});
