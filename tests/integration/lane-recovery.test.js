import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCli } from '../helpers/cli.js';
import { isAlive, requireMacGui, waitFor } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

const home = makeTmpDir('lane-recovery');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `lane-recovery-socket-${process.pid}`);
const session = `recovery-profile-${process.pid}`;
const lane = `recovery-lane-${process.pid}`;
const fixture = join(home, 'recovery-fixture.html');
let firstPid = null;

function cli(args) {
  return runCli(args, {
    home,
    env: {
      WEB_PLANE_RUNTIME_DIR: runtime,
      AGENT_BROWSER_SOCKET_DIR: socketDir,
    },
  });
}

function statusPid() {
  const result = cli([`-s=${session}`, 'status']);
  if (result.code !== 0) return null;
  const match = result.stdout.match(/Chrome PID:\s+(\d+)/);
  return match ? Number(match[1]) : null;
}

before(() => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  writeFileSync(
    fixture,
    '<!doctype html><title>Native Recovery Fixture</title>' +
      '<main>NATIVE_RECOVERY_MARKER</main><input aria-label="Draft">\n'
  );
  console.log('lane-recovery: installing an isolated exact-checkout runtime');
  const installed = cli(['install']);
  assert.equal(installed.code, 0, installed.all);
  const doctor = cli(['doctor']);
  assert.equal(doctor.code, 0, doctor.all);

  console.log('lane-recovery: attaching the initial lane');
  const attached = cli([
    `-s=${session}`,
    'attach',
    '--as',
    lane,
    pathToFileURL(fixture).href,
  ]);
  assert.equal(attached.code, 0, attached.all);
  firstPid = statusPid();
  assert.ok(firstPid && isAlive(firstPid), `missing initial Chrome pid: ${attached.all}`);
  const snapshot = cli(['lane', lane, 'snapshot']);
  assert.equal(snapshot.code, 0, snapshot.all);
  assert.match(snapshot.stdout, /NATIVE_RECOVERY_MARKER/);
});

after(() => {
  try { cli([`-s=${session}`, 'close']); } catch {}
  try { cli(['agent-browser', '--session', lane, 'close']); } catch {}
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('a killed browser restores natively, rebinds once, and does not replay the command', async () => {
  // Give Chrome's session service time to flush the attached file URL before
  // simulating the process loss this feature is meant to recover from.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.kill(firstPid, 'SIGKILL');
  const stopped = await waitFor(() => isAlive(firstPid), (alive) => !alive, {
    timeoutMs: 10_000,
    everyMs: 100,
  });
  assert.equal(stopped.ok, true, `Chrome ${firstPid} did not exit`);

  console.log('lane-recovery: invoking the command that discovers the dead browser');
  const recovered = cli(['lane', lane, 'snapshot']);
  assert.equal(recovered.code, 0, recovered.all);
  assert.match(recovered.stderr, /restored lane .*Chrome's saved session/);
  assert.match(recovered.stderr, /previous command was not replayed/);
  assert.doesNotMatch(recovered.stdout, /NATIVE_RECOVERY_MARKER/);

  console.log('lane-recovery: verifying the next command uses the rebound target');
  const verified = cli(['lane', lane, 'snapshot']);
  assert.equal(verified.code, 0, verified.all);
  assert.match(verified.stdout, /NATIVE_RECOVERY_MARKER/);

  const secondPid = statusPid();
  assert.ok(secondPid && secondPid !== firstPid && isAlive(secondPid));
  const laneFiles = readdirSync(join(runtime, 'lanes')).filter((name) => name.endsWith('.json'));
  assert.equal(laneFiles.length, 1, laneFiles.join(', '));
  const statePath = join(runtime, 'lanes', laneFiles[0]);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.session, session);
  assert.equal(state.url, pathToFileURL(fixture).href);
  assert.ok(state.port > 0);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);

  const backupRoot = join(runtime, 'backups', 'chrome-sessions', encodeURIComponent(session));
  assert.ok(
    readdirSync(backupRoot).some((name) => name.startsWith('backup-')),
    'native session files were not backed up before relaunch'
  );
});
