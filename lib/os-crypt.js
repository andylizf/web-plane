import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';

// Why this module exists
//
// Playwright launches the managed Chrome with `--use-mock-keychain`, so every
// cookie, saved password and sign-in token in a web-plane profile is encrypted
// under Chromium's fixed mock-keychain password, never the "Chrome Safe
// Storage" Keychain item. What changes between Chrome releases is the key
// derived from it and the tag written in front of each value:
//
//   v10  PBKDF2-SHA1("mock_password", "saltysalt", 1003) — Chrome 155 and older
//   v11  PBKDF2-SHA1("mock_password", "pepper",    1003) — Chrome 158
//
// Chrome 158 enables `KeychainKeyProviderUserDataDirProtection` by default:
// for any non-default --user-data-dir (every web-plane profile) it registers the
// "v10" key as unavailable and encrypts with "v11" instead
// (chrome/browser/browser_process_impl.cc). Rows it cannot decrypt are dropped
// on load, so the first 158 launch of a 155-era profile silently deleted every
// cookie in it. Disabling the feature only moves the loss: then every v11 row a
// 158 profile has written is dropped instead.
//
// So web-plane carries the data across itself. It learns which tag the clone
// writes by running the clone once on a scratch directory (no version table to
// go stale), and before launching an idle profile it re-encrypts each
// credential value from the other known tag into that one. A clone that writes
// a tag this file does not know refuses to launch rather than guess.

const MOCK_KEYCHAIN_PASSWORD = 'mock_password';
const IV = Buffer.alloc(16, 0x20);
export const KEY_SALTS = { v10: 'saltysalt', v11: 'pepper' };
const KNOWN_TAGS = Object.keys(KEY_SALTS);

// Every column Chrome encrypts with OSCrypt that carries a login. Cookies keep
// sessions; logins.password_value is the password manager; token_service holds
// the Google account's refresh token.
export const ENCRYPTED_COLUMNS = [
  { file: 'Cookies', table: 'cookies', column: 'encrypted_value', host: 'host_key' },
  { file: 'Login Data', table: 'logins', column: 'password_value' },
  { file: 'Login Data For Account', table: 'logins', column: 'password_value' },
  { file: 'Web Data', table: 'token_service', column: 'encrypted_token' },
  { file: 'Account Web Data', table: 'token_service', column: 'encrypted_token' },
];

const PROBE_SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), 'os-crypt-probe.js');
const PROBE_TIMEOUT_MS = 60_000;

const keys = new Map();
function keyFor(tag) {
  if (!keys.has(tag)) {
    keys.set(tag, pbkdf2Sync(MOCK_KEYCHAIN_PASSWORD, KEY_SALTS[tag], 1003, 16, 'sha1'));
  }
  return keys.get(tag);
}

export function encryptValue(tag, plaintext) {
  const cipher = createCipheriv('aes-128-cbc', keyFor(tag), IV);
  return Buffer.concat([Buffer.from(tag), cipher.update(plaintext), cipher.final()]);
}

/** The plaintext, or null when `blob` is not a value this tag's key encrypted. */
export function decryptValue(tag, blob) {
  if (blob.subarray(0, 3).toString('latin1') !== tag) return null;
  try {
    const decipher = createDecipheriv('aes-128-cbc', keyFor(tag), IV);
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
}

function sqlite(db, sql, { json = false, input } = {}) {
  const args = json ? ['-json', db, sql] : [db];
  return execFileSync('sqlite3', args, {
    encoding: 'utf8',
    input: json ? undefined : input ?? sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Opened read-write on purpose, never mode=ro: a Chrome that was killed
// mid-write leaves a hot rollback journal, and only a writable connection can
// roll it back. Read-only, every query fails ("attempt to write a readonly
// database") and the launch would be refused for a routine crash. Rolling the
// journal back is what Chrome itself does on its next open. The profile is
// idle here (callers check), and existsSync guards keep this from creating files.
function rows(db, sql) {
  const out = sqlite(db, sql, { json: true }).trim();
  return out ? JSON.parse(out) : [];
}

function hasTable(db, table, column) {
  return rows(db, `select name from pragma_table_info('${table}') where name = '${column}'`).length > 0;
}

// Cookie DB schema 24 (Chrome 130+) prefixes every plaintext with
// SHA-256(host_key); checking it proves a decrypt is right, not just
// well-padded.
function cookieHashPrefix(db) {
  const meta = rows(db, `select value from meta where key = 'version'`);
  return Number(meta[0]?.value ?? 0) >= 24;
}

export function chromeVersion(chromeApp = paths.chromeApp) {
  try {
    return execFileSync(
      'defaults',
      ['read', join(chromeApp, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Run `chromeBin` once on a scratch user-data-dir with the managed launch's
 * keychain switches, store one cookie, and report the tag Chrome wrote.
 */
export function probeKeyTag(chromeBin) {
  mkdirSync(paths.runtimeStagingDir, { recursive: true });
  const dir = join(paths.runtimeStagingDir, `os-crypt-probe-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const result = spawnSync(process.execPath, [PROBE_SCRIPT, chromeBin, dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (result.status !== 0) {
      throw new Error(`encryption probe failed: ${(result.stderr || result.error?.message || '').trim()}`);
    }
    const db = join(dir, 'Default', 'Cookies');
    const found = rows(db, `select distinct cast(substr(encrypted_value, 1, 3) as text) as tag from cookies`);
    if (found.length !== 1) throw new Error(`encryption probe wrote ${found.length} cookie tags`);
    return found[0].tag;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(paths.osCryptState, 'utf8'));
  } catch {
    return null;
  }
}

export function recordKeyTag(version, tag) {
  const staged = `${paths.osCryptState}.web-plane-staged`;
  writeFileSync(
    staged,
    `${JSON.stringify({ chromeVersion: version, tag, probedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  renameSync(staged, paths.osCryptState);
}

/** What doctor reports: the recorded probe, and whether it still describes the clone. */
export function keyTagState() {
  const state = readState();
  const version = chromeVersion();
  return {
    state,
    version,
    current: Boolean(state && version && state.chromeVersion === version),
    known: Boolean(state && KNOWN_TAGS.includes(state.tag)),
  };
}

/**
 * The tag the managed clone encrypts with. Probed once per clone version: the
 * clone's own updater can replace it in place, so the record is checked against
 * the version on disk every time.
 */
export function cloneKeyTag() {
  const version = chromeVersion();
  if (!version) throw new Error(`cannot read the clone's version at ${paths.chromeApp}`);
  const state = readState();
  if (state?.chromeVersion === version && state.tag) return state.tag;
  const tag = probeKeyTag(paths.chromeBin);
  recordKeyTag(version, tag);
  return tag;
}

function backupDatabase(db, session, stamp) {
  const dir = join(paths.runtimeBackupsDir, 'os-crypt', encodeURIComponent(session), stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const name = db.split('/').pop();
  const destination = join(dir, name);
  sqlite(db, `.backup '${destination.replaceAll("'", "''")}'`);
  chmodSync(destination, 0o600);
  return destination;
}

/**
 * Re-encrypt one profile's credential values into `target`. The profile must
 * not be running: Chrome holds these databases open and would overwrite the
 * change. Each database is backed up with sqlite's .backup before its single
 * write transaction, and every rewritten value is decrypted again afterwards.
 */
export function migrateProfileEncryption(session, target, profileDir = join(paths.profilesDir, session)) {
  if (!KNOWN_TAGS.includes(target)) {
    throw new Error(
      `the managed Chrome encrypts profile data with an unknown scheme '${target}'; ` +
        `opening a profile written under ${KNOWN_TAGS.join('/')} would drop its cookies`
    );
  }
  const sources = KNOWN_TAGS.filter((tag) => tag !== target);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const report = { target, migrated: 0, unreadable: 0, files: [], backups: [] };

  for (const spec of ENCRYPTED_COLUMNS) {
    const db = join(profileDir, 'Default', spec.file);
    if (!existsSync(db) || !hasTable(db, spec.table, spec.column)) continue;
    const prefixes = sources.map((tag) => `X'${Buffer.from(tag).toString('hex')}'`).join(', ');
    const candidates = rows(
      db,
      `select rowid as id, hex(${spec.column}) as value${spec.host ? `, ${spec.host} as host` : ''} ` +
        `from ${spec.table} where substr(${spec.column}, 1, 3) in (${prefixes})`
    );
    if (!candidates.length) continue;
    const checkHost = spec.host && cookieHashPrefix(db);

    const updates = [];
    for (const row of candidates) {
      const blob = Buffer.from(row.value, 'hex');
      const tag = blob.subarray(0, 3).toString('latin1');
      const plain = decryptValue(tag, blob);
      const valid = plain && (!checkHost ||
        plain.subarray(0, 32).equals(createHash('sha256').update(row.host).digest()));
      if (!valid) {
        // Encrypted by something other than the mock keychain (a system-Chrome
        // copy, say). Chrome cannot read it under any web-plane launch either;
        // leave it exactly as it is.
        report.unreadable++;
        continue;
      }
      updates.push({ id: row.id, plain, value: encryptValue(target, plain) });
    }
    if (!updates.length) continue;

    report.backups.push(backupDatabase(db, session, stamp));
    const sql = [
      'BEGIN IMMEDIATE;',
      ...updates.map(({ id, value }) =>
        `UPDATE ${spec.table} SET ${spec.column} = X'${value.toString('hex')}' WHERE rowid = ${Number(id)};`),
      'COMMIT;',
    ].join('\n');
    sqlite(db, null, { input: sql });

    const after = new Map(rows(db, `select rowid as id, hex(${spec.column}) as value from ${spec.table}`)
      .map((row) => [row.id, Buffer.from(row.value, 'hex')]));
    for (const { id, plain } of updates) {
      const reread = decryptValue(target, after.get(id) ?? Buffer.alloc(0));
      if (!reread || !reread.equals(plain)) {
        throw new Error(`re-encryption check failed for ${spec.file} row ${id}; backup: ${report.backups.at(-1)}`);
      }
    }
    report.migrated += updates.length;
    report.files.push({ file: spec.file, rows: updates.length });
  }
  return report;
}

/**
 * The pre-launch step for an idle profile: bring its credentials onto the
 * clone's key. Returns the migration report; throws when the launch would
 * lose data.
 */
export function carryProfileEncryption(session) {
  return migrateProfileEncryption(session, cloneKeyTag());
}
