import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import {
  PANEL_PROTOCOL,
  panelRequestPaths,
  parsePanelArgs,
  sendPanelRequest,
} from '../../lib/panel.js';

test('panel status is the default and accepts machine-readable output explicitly', () => {
  assert.deepEqual(parsePanelArgs([]), { action: 'status', path: null, json: false });
  assert.deepEqual(parsePanelArgs(['status', '--json']), {
    action: 'status',
    path: null,
    json: true,
  });
});

test('panel accept requires an absolute path', () => {
  assert.match(parsePanelArgs(['accept']).error, /requires '--path/);
  assert.match(parsePanelArgs(['accept', '--path', 'relative.txt']).error, /must be absolute/);
  assert.deepEqual(parsePanelArgs(['accept', '--path=/Users/test/file.txt']), {
    action: 'accept',
    path: '/Users/test/file.txt',
    json: false,
  });
});

test('panel commands reject actions and flags outside the narrow protocol', () => {
  assert.match(parsePanelArgs(['click', 'OK']).error, /unknown panel action/);
  assert.match(parsePanelArgs(['cancel', '--path=/Users/test/file.txt']).error, /does not accept/);
  assert.match(parsePanelArgs(['status', '--selector=ok:']).error, /unknown panel argument/);
});

test('each panel request has one run-scoped request and response path', () => {
  assert.deepEqual(panelRequestPaths('/run', 'run-id', 'request-id'), {
    request: join('/run', '.panel-request-run-id-request-id.json'),
    response: join('/run', '.panel-response-run-id-request-id.json'),
  });
  assert.equal(PANEL_PROTOCOL, 1);
});

test('the transport refuses browsers without the matching injected runtime', async () => {
  assert.equal(
    (await sendPanelRequest({ pid: 123, managed: false, runId: null }, { action: 'status' })).error.code,
    'UNMANAGED_BROWSER'
  );
  assert.equal(
    (await sendPanelRequest({ pid: 123, managed: true, runId: null }, { action: 'status' })).error.code,
    'MISSING_RUN_ID'
  );
});
