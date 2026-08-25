import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import test from 'node:test';

import { makeTmpDir } from '../helpers/tmpdir.js';

const runtime = makeTmpDir('lane-events');
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const {
  appendLaneEvent,
  eventWarnings,
  formatNetlog,
  laneEventOffset,
  laneEventsPath,
  parseNetlogArgs,
  readLaneEvents,
  readLaneEventsAfter,
  setLaneEventCursor,
} = await import(`../../lib/lane-events.js?test=${Date.now()}`);

test.after(() => rmSync(runtime, { recursive: true, force: true }));

test('lane event JSONL is append-only, timestamped, and survives malformed records', () => {
  const first = appendLaneEvent('work', 'lane-a', {
    type: 'request-failed',
    method: 'POST',
    url: 'https://example.com/save',
    errorText: 'net::ERR_FAILED',
  });
  appendFileSync(first.path, '{malformed\n');
  appendLaneEvent('work', 'lane-a', { type: 'console', level: 'error', text: 'bad state' });

  const events = readLaneEvents('work', 'lane-a');
  assert.equal(events.length, 2);
  assert.match(events[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(events[0].errorText, 'net::ERR_FAILED');
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
});

test('netlog parsing supports failed, since, and non-destructive clear cursors', () => {
  assert.deepEqual(parseNetlogArgs(['netlog', '--failed', '--since', '30']), {
    failed: true,
    sinceSeconds: 30,
    clear: false,
  });
  assert.deepEqual(parseNetlogArgs(['netlog', '--clear']), {
    failed: false,
    sinceSeconds: null,
    clear: true,
  });
  assert.throws(() => parseNetlogArgs(['netlog', '--since', 'soon']), /seconds/);
  assert.throws(() => parseNetlogArgs(['netlog', '--unknown']), /unknown netlog argument/);

  const before = laneEventOffset('work', 'lane-a');
  setLaneEventCursor('work', 'lane-a', before);
  appendLaneEvent('work', 'lane-a', { type: 'request', method: 'GET', url: 'https://x.test' });
  assert.equal(readLaneEventsAfter('work', 'lane-a', before).length, 1);
  assert.ok(laneEventsPath('work', 'lane-a').endsWith('.events.jsonl'));
});

test('failed netlog renders HTTP failures and CDP errorText without request bodies', () => {
  const output = formatNetlog([
    {
      timestamp: '2026-08-25T12:00:00.000Z',
      type: 'request-failed',
      method: 'POST',
      url: 'https://example.com/save',
      errorText: 'net::ERR_FAILED',
      requestBody: 'must not print',
    },
    {
      timestamp: '2026-08-25T12:00:01.000Z',
      type: 'response-failed',
      method: 'GET',
      url: 'https://example.com/missing',
      status: 404,
    },
  ], { failed: true });

  assert.match(output, /POST https:\/\/example\.com\/save — net::ERR_FAILED/);
  assert.match(output, /GET https:\/\/example\.com\/missing — HTTP 404/);
  assert.doesNotMatch(output, /must not print/);
});

test('successful input commands warn about new page and request failures only', () => {
  const warnings = eventWarnings([
    { type: 'request', method: 'GET', url: 'https://example.com' },
    { type: 'console', level: 'log', text: 'ordinary' },
    { type: 'console', level: 'error', text: 'save failed' },
    { type: 'page-error', text: 'uncaught' },
    { type: 'request-failed', method: 'POST', url: 'https://example.com/save', errorText: 'net::ERR_FAILED' },
  ]);

  assert.equal(warnings.length, 3);
  assert.match(warnings.join('\n'), /save failed/);
  assert.match(warnings.join('\n'), /uncaught/);
  assert.match(warnings.join('\n'), /net::ERR_FAILED/);
});
