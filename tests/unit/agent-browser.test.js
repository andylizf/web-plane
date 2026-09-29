import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  agentBrowserSidecarPaths,
  normalizeSpawnTimeout,
  runAgentBrowser,
} from '../../lib/agent-browser.js';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

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

test("the caller's proxy never reaches the driver", () => {
  // A credentialed proxy makes agent-browser intercept every request in the
  // shared Chrome, so the driver must not inherit one from whoever runs us.
  const dir = makeTmpDir('driver-env');
  const fake = join(dir, 'agent-browser');
  writeFileSync(fake, '#!/bin/sh\nenv\n');
  chmodSync(fake, 0o755);
  const proxy = 'http://user:secret@127.0.0.1:9';
  const names = [
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
    'AGENT_BROWSER_PROXY', 'AGENT_BROWSER_PROXY_BYPASS',
    'AGENT_BROWSER_PROXY_USERNAME', 'AGENT_BROWSER_PROXY_PASSWORD',
  ];
  const saved = Object.fromEntries(
    ['WEB_PLANE_TEST_AGENT_BROWSER_BIN', ...names].map((name) => [name, process.env[name]])
  );
  try {
    process.env.WEB_PLANE_TEST_AGENT_BROWSER_BIN = fake;
    for (const name of names) process.env[name] = proxy;
    const result = runAgentBrowser(['--session', 'lane', 'get', 'title'], {
      cdpPort: 9222, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const seen = result.stdout.split('\n').map((line) => line.split('=')[0]);
    assert.deepEqual(names.filter((name) => seen.includes(name)), []);
    assert.ok(seen.includes('PATH'), 'the rest of the environment is passed through');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeTmpDir(dir);
  }
});
