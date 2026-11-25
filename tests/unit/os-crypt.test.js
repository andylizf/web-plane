import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

const runtime = makeTmpDir('os-crypt');
process.env.WEB_PLANE_RUNTIME_DIR = runtime;
const {
  decryptValue,
  encryptValue,
  migrateProfileEncryption,
} = await import(`../../lib/os-crypt.js?test=${Date.now()}`);

test.after(() => removeTmpDir(runtime));

// Chrome 155 and Chrome 158 each wrote this cookie (example.com wp_probe=
// seeded-by-155) into a throwaway profile launched with Playwright's
// --use-mock-keychain. They pin the two keys to what Chrome itself does, not to
// what this module believes Chrome does.
const CHROME_155_V10 = '7631301C7915ACD20A79FC38A27E3AC6396497F930BB664D39411E2D32C88BCD45C071403CD83620A85FFC2EFCBC931BE1F21F';
const CHROME_158_V11 = '763131F009FECA2562E75B1B21E78CB392F643A7E224E5BFE4AB633AD9AB34FCADE671AE468078BB98D3C5A6894169D666A8AF';

function hostHash(host) {
  return createHash('sha256').update(host).digest();
}

function sqlite(db, sql) {
  return execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' });
}

function cookiePlain(host, value) {
  return Buffer.concat([hostHash(host), Buffer.from(value)]);
}

/** A profile with Chrome's real cookie schema (meta version 24) and a Login Data file. */
function makeProfile(session, cookies, logins = []) {
  const dir = join(runtime, 'profiles', session, 'Default');
  mkdirSync(dir, { recursive: true });
  const db = join(dir, 'Cookies');
  sqlite(db, [
    `CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);`,
    `INSERT INTO meta VALUES('version','24');`,
    `CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);`,
    ...cookies.map(({ host, name, blob }, i) =>
      `INSERT INTO cookies VALUES(${13400000000000000 + i},'${host}','','${name}','',X'${blob.toString('hex')}','/',0,1,0,0,1,1,1,0,2,443,0,0,0);`),
  ].join('\n'));
  const login = join(dir, 'Login Data');
  sqlite(login, [
    `CREATE TABLE logins(origin_url VARCHAR NOT NULL, password_value BLOB);`,
    ...logins.map(({ origin, blob }) => `INSERT INTO logins VALUES('${origin}', X'${blob.toString('hex')}');`),
  ].join('\n'));
  return { db, login };
}

function column(db, sql) {
  return JSON.parse(execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' }) || '[]')
    .map((row) => Buffer.from(row.v, 'hex'));
}

test('the derived keys decrypt what Chrome 155 (v10) and Chrome 158 (v11) actually wrote', () => {
  const expected = cookiePlain('example.com', 'seeded-by-155');
  assert.deepEqual(decryptValue('v10', Buffer.from(CHROME_155_V10, 'hex')), expected);
  assert.deepEqual(decryptValue('v11', Buffer.from(CHROME_158_V11, 'hex')), expected);
  // Each key rejects the other's ciphertext rather than returning garbage.
  assert.equal(decryptValue('v11', Buffer.from(CHROME_155_V10, 'hex')), null);
  // Encryption is deterministic (fixed IV), so it reproduces Chrome's bytes.
  assert.equal(encryptValue('v11', expected).toString('hex').toUpperCase(), CHROME_158_V11);
});

test('a 155-era profile is carried onto v11 with every value intact and a backup kept', () => {
  const cookies = [
    { host: '.example.com', name: 'sid', blob: encryptValue('v10', cookiePlain('.example.com', 'session-1')) },
    { host: 'login.example.org', name: 'auth', blob: encryptValue('v10', cookiePlain('login.example.org', 'token-2')) },
  ];
  const logins = [{ origin: 'https://example.com/', blob: encryptValue('v10', Buffer.from('hunter2')) }];
  const { db, login } = makeProfile('legacy', cookies, logins);

  const report = migrateProfileEncryption('legacy', 'v11');
  assert.equal(report.migrated, 3);
  assert.equal(report.unreadable, 0);
  assert.deepEqual(report.files, [{ file: 'Cookies', rows: 2 }, { file: 'Login Data', rows: 1 }]);

  const after = column(db, `select hex(encrypted_value) as v from cookies order by rowid`);
  assert.deepEqual(after.map((b) => b.subarray(0, 3).toString()), ['v11', 'v11']);
  assert.deepEqual(decryptValue('v11', after[0]), cookiePlain('.example.com', 'session-1'));
  assert.deepEqual(decryptValue('v11', after[1]), cookiePlain('login.example.org', 'token-2'));
  const [password] = column(login, `select hex(password_value) as v from logins`);
  assert.deepEqual(decryptValue('v11', password), Buffer.from('hunter2'));

  // The backups are the databases as they were before the rewrite.
  assert.equal(report.backups.length, 2);
  const [backup] = column(report.backups[0], `select hex(encrypted_value) as v from cookies order by rowid limit 1`);
  assert.deepEqual(backup, cookies[0].blob);
  assert.equal(readFileSync(report.backups[0]).subarray(0, 15).toString(), 'SQLite format 3');

  // A profile already on the clone's key is left alone: no write, no backup.
  const again = migrateProfileEncryption('legacy', 'v11');
  assert.equal(again.migrated, 0);
  assert.deepEqual(again.backups, []);
});

test('a v11 profile opened by a v10 Chrome is carried back, so neither direction drops cookies', () => {
  const { db } = makeProfile('newer', [
    { host: 'a.test', name: 'x', blob: encryptValue('v11', cookiePlain('a.test', 'value-x')) },
  ]);
  const report = migrateProfileEncryption('newer', 'v10');
  assert.equal(report.migrated, 1);
  const [blob] = column(db, `select hex(encrypted_value) as v from cookies`);
  assert.deepEqual(decryptValue('v10', blob), cookiePlain('a.test', 'value-x'));
});

test('a value no mock-keychain key opens is left byte-for-byte as it was', () => {
  // A v10 value whose plaintext does not start with its host's hash: what a
  // copy of a system-Chrome cookie (real Keychain key) looks like from here.
  const foreign = encryptValue('v10', cookiePlain('other.test', 'not-for-this-host'));
  const { db } = makeProfile('foreign', [{ host: 'mine.test', name: 'f', blob: foreign }]);
  const report = migrateProfileEncryption('foreign', 'v11');
  assert.equal(report.migrated, 0);
  assert.equal(report.unreadable, 1);
  assert.deepEqual(column(db, `select hex(encrypted_value) as v from cookies`)[0], foreign);
});

test('an unknown target scheme is refused before anything is touched', () => {
  const blob = encryptValue('v10', cookiePlain('keep.test', 'v'));
  const { db } = makeProfile('unknown', [{ host: 'keep.test', name: 'k', blob }]);
  assert.throws(() => migrateProfileEncryption('unknown', 'v12'), /unknown scheme 'v12'/);
  assert.deepEqual(column(db, `select hex(encrypted_value) as v from cookies`)[0], blob);
  assert.equal(existsSync(join(runtime, 'backups', 'os-crypt', 'unknown')), false);
});
