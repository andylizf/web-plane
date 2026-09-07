import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CLI } from '../helpers/cli.js';
import { requireMacGui } from '../helpers/browser.js';
import { makeTmpDir, removeTmpDir, REPO_ROOT } from '../helpers/tmpdir.js';

const execute = promisify(execFile);
const home = makeTmpDir('lane-webauthn');
const runtime = join(home, '.web-plane');
const socketDir = join(REPO_ROOT, 'tmp', `w${process.pid}`);
const session = `wp${process.pid}`;
const lane = `wl${process.pid}`;
let server;
let url;

async function cli(args) {
  try {
    return { code: 0, ...await execute(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, WEB_PLANE_RUNTIME_DIR: runtime,
        AGENT_BROWSER_SOCKET_DIR: socketDir },
      timeout: 120_000,
    }) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function evaluate(expression, name = lane) {
  const result = await cli(['lane', name, 'eval', expression, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data.result;
}

before(async () => {
  requireMacGui();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  server = createServer((req, res) => res.end(`<!doctype html>
    <button onclick="document.body.dataset.fallback='clicked'">Use another method</button>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // WebAuthn rejects IP-literal relying-party IDs before reaching an authenticator.
  url = `http://localhost:${server.address().port}/`;
  const installed = await cli(['install']);
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
});

after(async () => {
  await cli([`-s=${session}`, 'close']);
  server?.closeAllConnections();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  removeTmpDir(socketDir);
  removeTmpDir(home);
});

test('opt-in interception survives CLI exit and navigation without blocking fallback input', async () => {
  const attached = await cli([`-s=${session}`, 'attach', '--as', lane, '--no-webauthn', url]);
  assert.equal(attached.code, 0, attached.stdout + attached.stderr);
  assert.match(attached.stdout, /WebAuthn: disabled/);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      const navigation = await cli(['lane', lane, 'goto', `${url}?again`]);
      assert.equal(navigation.code, 0, navigation.stderr);
    }
    await evaluate(`window.outcome='pending'; window.requestAbort = new AbortController();
      navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),timeout:15000},
        signal:requestAbort.signal})
        .then(()=>outcome='success', error=>outcome=error.name); 'started'`);
    assert.equal(await evaluate('outcome'), 'pending');
    const clicked = await cli(['lane', lane, 'find', 'role', 'button', '--name', 'Use another method', 'click']);
    assert.equal(clicked.code, 0, clicked.stdout + clicked.stderr);
    assert.equal(await evaluate('document.body.dataset.fallback'), 'clicked');
    await evaluate("requestAbort.abort(); 'aborted'");
  }
});

test('the empty environment cannot register credentials', async () => {
  const outcome = await evaluate(`navigator.credentials.create({publicKey:{
    challenge:new Uint8Array(32),rp:{name:'Local test'},
    user:{id:new Uint8Array([1]),name:'test',displayName:'Test'},
    pubKeyCredParams:[{type:'public-key',alg:-7}],timeout:1000},
    signal:AbortSignal.timeout(2000)})
    .then(()=> 'success',error=>error.name)`);
  assert.ok(['NotAllowedError', 'TimeoutError'].includes(outcome), outcome);
});

test('another lane and an explicit reattach retain normal authenticator discovery', async () => {
  const sibling = `${lane}s`;
  const attached = await cli([`-s=${session}`, 'attach', '--as', sibling, url]);
  assert.equal(attached.code, 0, attached.stdout + attached.stderr);
  const normal = await evaluate('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()', sibling);
  assert.equal(await evaluate('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()'), false);
  const restored = await cli([`-s=${session}`, 'attach', '--as', lane, url]);
  assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  assert.doesNotMatch(restored.stdout, /WebAuthn: disabled/);
  assert.equal(await evaluate('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()'), normal);
});
