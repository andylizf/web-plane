import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentBrowserSidecarPaths,
  normalizeSpawnTimeout,
} from '../../lib/agent-browser.js';

test('a bounded subprocess timeout becomes a named non-zero result', () => {
  const result = normalizeSpawnTimeout(
    { status: null, stderr: '', error: { code: 'ETIMEDOUT' } },
    { phase: 'Playwright hidden launch', timeoutMs: 45_000 }
  );
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /Playwright hidden launch timed out after 45000ms/);
});

test('ordinary subprocess results are preserved', () => {
  const result = { status: 0, stderr: '' };
  assert.equal(normalizeSpawnTimeout(result, { phase: 'connect', timeoutMs: 1 }), result);
});

test('daemon sidecars cannot escape their runtime directory', () => {
  assert.equal(agentBrowserSidecarPaths('../other-session'), null);
  assert.equal(agentBrowserSidecarPaths('nested/other-session'), null);
  assert.equal(agentBrowserSidecarPaths('lane with spaces'), null);
  assert.equal(agentBrowserSidecarPaths('lane\nnewline'), null);
  const paths = agentBrowserSidecarPaths('safe_lane-1');
  assert.match(paths.pid, /safe_lane-1\.pid$/);
  assert.match(paths.sock, /safe_lane-1\.sock$/);
});
