import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

let dir;
let dylib;
let host;
let runDir;

before(() => {
  dir = makeTmpDir('window-scope');
  dylib = join(dir, 'window_suppress.dylib');
  host = join(dir, 'window_scope_host');
  runDir = join(dir, 'run');
  mkdirSync(runDir, { mode: 0o700 });
  execFileSync('cc', [
    '-Wall',
    '-Werror',
    '-dynamiclib',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    dylib,
    join(REPO_ROOT, 'native', 'window_suppress.m'),
  ]);
  execFileSync('cc', [
    '-Wall',
    '-Werror',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-o',
    host,
    join(REPO_ROOT, 'tests', 'native', 'window_scope_host.m'),
  ]);
  execFileSync('codesign', ['--force', '--sign', '-', host], { stdio: 'ignore' });
});

after(() => dir && removeTmpDir(dir));

test('hidden state cloaks browser frames but leaves native panels visible', () => {
  const result = spawnSync(host, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: dylib,
      WEB_PLANE_RUN_ID: '77953b53-c945-4db6-b02c-d599a0928702',
      WEB_PLANE_RUN_DIR: runDir,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  assert.equal(observed.browserAlpha, 0);
  assert.ok(observed.browserX + 900 <= 100, `browser stayed at x=${observed.browserX}`);
  assert.equal(observed.panelAlpha, 1);
  assert.ok(observed.panelX + 520 > 100, `panel was parked at x=${observed.panelX}`);
});
