import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

const HOME = makeTmpDir('profiles-home');
process.env.HOME = HOME;
process.on('exit', () => removeTmpDir(HOME));

const { paths } = await import('../../lib/config.js');
const { isAuthCookie, profilesForSites, listProfiles } = await import('../../lib/profiles.js');

/**
 * A profile directory with a Chrome-shaped cookie DB in it.
 *
 * Written with the real sqlite3 and the real column names rather than stubbed,
 * because the failure this guards against lived in the gap between the cookie
 * name on disk and the name in the allowlist.
 */
function makeProfile(name, cookies) {
  const dir = join(paths.profilesDir, name, 'Default');
  mkdirSync(dir, { recursive: true });
  const db = join(dir, 'Cookies');
  const sql = [
    'CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB);',
    ...cookies.map(
      ([host, cookie]) =>
        `INSERT INTO cookies VALUES (1, '${host}', '${cookie}', '', X'00');`
    ),
  ].join('\n');
  execFileSync('sqlite3', [db], { input: sql, stdio: ['pipe', 'ignore', 'pipe'] });
  return join(paths.profilesDir, name);
}

test('a chunked NextAuth session cookie still counts as a login', () => {
  // Auth.js splits a session JWT across `<name>.0`, `<name>.1`, … so the name on
  // disk is never the name in the allowlist. Matching exactly reported a profile
  // with a live ChatGPT login as logged out — the one direction this must never
  // get wrong, because a false "logged out" sends an agent off to make a second
  // account.
  assert.equal(isAuthCookie('__Secure-next-auth.session-token.0'), true);
  assert.equal(isAuthCookie('__Secure-next-auth.session-token'), true);
  assert.equal(isAuthCookie('__Secure-authjs.session-token.11'), true);
});

test('an ordinary cookie is not mistaken for a session', () => {
  assert.equal(isAuthCookie('_ga'), false);
  assert.equal(isAuthCookie('theme'), false);
  assert.equal(isAuthCookie('NID'), false);
});

test('logins are read out of a real cookie database, leading dot stripped', () => {
  makeProfile('withlogin', [
    ['.chatgpt.com', '__Secure-next-auth.session-token.0'],
    ['.chatgpt.com', '__Secure-next-auth.session-token.1'],
    ['x.com', 'auth_token'],
    ['example.com', '_ga'],
  ]);
  makeProfile('empty', [['example.com', '_ga']]);

  const all = listProfiles();
  const withLogin = all.find((p) => p.name === 'withlogin');
  const empty = all.find((p) => p.name === 'empty');

  assert.deepEqual(withLogin.logins, ['chatgpt.com', 'x.com']);
  assert.deepEqual(empty.logins, []);
  assert.equal(withLogin.running, false);
});

test('a profile with no cookie DB is listed rather than dropped', () => {
  // A profile that has never been opened still has to appear — the listing is
  // how a caller finds the identity to reuse instead of creating a new one.
  mkdirSync(join(paths.profilesDir, 'fresh'), { recursive: true });
  assert.ok(listProfiles().some((p) => p.name === 'fresh'));
});

test('asking for a site finds the subdomain the login actually lives on', () => {
  const all = [
    { name: 'a', logins: ['accounts.google.com', 'google.com'] },
    { name: 'b', logins: ['x.com'] },
  ];
  assert.deepEqual(profilesForSites(all, ['google.com']).map((p) => p.name), ['a']);
  assert.deepEqual(profilesForSites(all, ['accounts.google.com']).map((p) => p.name), ['a']);
  assert.deepEqual(profilesForSites(all, ['x.com']).map((p) => p.name), ['b']);
  assert.deepEqual(profilesForSites(all, ['notlogged.in']), []);
});

test('a site is matched on domain boundaries, not on string suffix', () => {
  // `endsWith` alone would answer "yes, profile `evil` is logged into x.com" for
  // a cookie on `notx.com`, and the caller would drive the wrong identity.
  const all = [{ name: 'evil', logins: ['notx.com'] }];
  assert.deepEqual(profilesForSites(all, ['x.com']), []);
});
