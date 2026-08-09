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
const { isAuthCookie, looksLikeSessionCookie, listProfiles } = await import('../../lib/profiles.js');

/** Far enough out that the row is unexpired, in Chrome's 1601 microsecond epoch. */
const FUTURE = (Date.now() + 11644473600000 + 86400000) * 1000;
const PAST = (Date.now() + 11644473600000 - 86400000) * 1000;

/**
 * A profile directory with a Chrome-shaped cookie DB in it.
 *
 * Written with the real sqlite3 and the real column names rather than stubbed,
 * because the failures this guards against live in the gap between what is on
 * disk and what the code expects: first the cookie *name* (chunked, prefixed),
 * then its *shape* (a name-only match called a dead session-scoped cookie a
 * login).
 *
 * Each entry is [host, name, {httponly, secure, persistent, expires}], and the
 * options default to a durable HttpOnly+Secure cookie so that tests about names
 * do not have to restate the shape.
 */
function makeProfile(name, cookies) {
  const dir = join(paths.profilesDir, name, 'Default');
  mkdirSync(dir, { recursive: true });
  const db = join(dir, 'Cookies');
  const sql = [
    'CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT,' +
      ' encrypted_value BLOB, is_httponly INTEGER, is_secure INTEGER, is_persistent INTEGER,' +
      ' expires_utc INTEGER);',
    ...cookies.map(([host, cookie, opts = {}]) => {
      const { httponly = 1, secure = 1, persistent = 1, expires = FUTURE } = opts;
      return `INSERT INTO cookies VALUES (1, '${host}', '${cookie}', '', X'00', ${httponly}, ${secure}, ${persistent}, ${expires});`;
    }),
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
    // Not HttpOnly, which is what actually disqualifies it: analytics cookies
    // exist to be read by page scripts.
    ['example.com', '_ga', { httponly: 0 }],
  ]);
  makeProfile('empty', [['example.com', '_ga', { httponly: 0 }]]);

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

test('a session cookie is recognised by shape when its name is on no list', () => {
  // The bug this replaces: `web-plane profiles princeton.edu` reported "no
  // profile holds a session" against a profile that was fully logged in, because
  // Entra ships ESTSAUTH and Shibboleth ships `_shibsession_<hex>` — names no
  // allowlist can carry. A false "logged out" is what sends an agent off to make
  // the duplicate profile this module exists to prevent.
  makeProfile('sso', [
    ['login.microsoftonline.com', 'ESTSAUTHPERSISTENT'],
    ['fed.princeton.edu', 'SESSION'],
    ['idp.princeton.edu', '__Host-shib_idp_session'],
    ['pcsprod.princeton.edu', '_shibsession_64656661756c74'],
    ['tracker.example', '_ga', { httponly: 0 }],
  ]);
  const sso = listProfiles().find((p) => p.name === 'sso');
  assert.deepEqual(sso.logins, [
    'fed.princeton.edu',
    'idp.princeton.edu',
    'login.microsoftonline.com',
    'pcsprod.princeton.edu',
  ]);
});

test('the same name is matched past a __Host-/__Secure- prefix and past case', () => {
  // The prefixes are a server-side scoping guarantee, so a site adopts them
  // without renaming anything: `__Host-JSESSIONID` is still JSESSIONID. And one
  // framework spells it `session` where another spells it `SESSION`.
  assert.equal(isAuthCookie('__Host-JSESSIONID'), true);
  assert.equal(isAuthCookie('SESSION'), true);
  assert.equal(isAuthCookie('_shibsession_deadbeef'), true);
});

test('a known name does not count when the cookie cannot outlive the browser', () => {
  // The error in the other direction, and the reason durability is a gate rather
  // than one vote: chsi.com.cn was reported as logged in off a session-scoped
  // JSESSIONID whose session had ended days earlier, which made a stale profile
  // look precious.
  assert.equal(
    looksLikeSessionCookie({ name: 'JSESSIONID', httponly: true, secure: true, persistent: false, expires: FUTURE }),
    false
  );
  assert.equal(
    looksLikeSessionCookie({ name: 'JSESSIONID', httponly: true, secure: true, persistent: true, expires: PAST }),
    false
  );
});

test('a cookie page scripts can read is not treated as a credential', () => {
  // Analytics and consent cookies are persistent and unexpired too; what they are
  // not is HttpOnly, because their whole purpose is to be read by front-end JS.
  assert.equal(
    looksLikeSessionCookie({ name: '_ga', httponly: false, secure: true, persistent: true, expires: FUTURE }),
    false
  );
});

test('a name match outranks a shape match in the listing', () => {
  // The listing only prints the first few hosts, and third-party ad domains set
  // HttpOnly, Secure, persistent cookies too — on a real profile there are
  // dozens. Sorted alphabetically they buried the actual logins behind `1rx.io`.
  makeProfile('mixed', [
    ['1rx.io', 'uid'],
    ['360yield.com', 'tuuid'],
    ['zzz-university.edu', 'ESTSAUTH'],
  ]);
  const mixed = listProfiles().find((p) => p.name === 'mixed');
  assert.equal(mixed.logins[0], 'zzz-university.edu');
  assert.deepEqual(mixed.logins.slice(1).sort(), ['1rx.io', '360yield.com']);
});
