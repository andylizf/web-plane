import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { paths } from './config.js';
import { chromeProcs } from './health.js';

/**
 * Cookie names that mean "this profile holds a live session for that host".
 *
 * Presence is a strong hint, not proof — a stale cookie survives a logout on the
 * server side — so callers should treat the answer as "start here", not "you are
 * logged in". **Absence proves nothing either**, which is the correction to what
 * this comment used to claim. Session cookie names are invented per application
 * and cannot be enumerated: Entra ships ESTSAUTH, CAS ships TGC, PeopleSoft ships
 * PS_TOKEN, and Shibboleth ships `_shibsession_<hex>`, whose name is not even a
 * constant. A name list is a floor on what we can recognise, never a ceiling on
 * what exists — so it is backed by `looksLikeSessionCookie` below, which asks
 * what a cookie *is* rather than what it is called.
 */
const AUTH_COOKIES = new Set([
  'auth_token', // x.com
  'sessionid', // instagram, django
  'user_session', // github
  '_gh_sess',
  'li_at', // linkedin
  'SID', // google (also LSID/__Secure-1PSID below)
  'LSID',
  '__Secure-1PSID',
  '__Host-GAPS',
  'SESSDATA', // bilibili
  'JSESSIONID',
  'PHPSESSID',
  'connect.sid',
  'session',
  'session_id',
  'remember_token',
  'access_token',
  '__Secure-next-auth.session-token', // NextAuth v4 — chatgpt.com and much of the Next.js web
  '__Secure-authjs.session-token', // Auth.js v5, the same cookie after the rename
  // Enterprise SSO. Worth naming even though the shape test would catch them
  // anyway: a name match is the stronger signal, and these decide whether a
  // university or company login sorts above the ad-tech noise in the listing.
  'ESTSAUTH', // Microsoft Entra
  'ESTSAUTHPERSISTENT',
  'TGC', // CAS ticket-granting cookie
  'shib_idp_session', // Shibboleth IdP (ships as __Host-shib_idp_session)
  'PS_TOKEN', // Oracle PeopleSoft
  'MOD_AUTH_CAS',
]);

/**
 * The `.0` / `.1` on a chunked cookie, removed.
 *
 * Auth.js and NextAuth split a session JWT that would exceed the 4096-byte
 * cookie limit across `<name>.0`, `<name>.1`, … so the name on disk is never the
 * name in the list above. chatgpt.com does exactly this, and matching the exact
 * name reported a profile with a live ChatGPT login as logged out — the one
 * direction this module promises not to get wrong, because a false "logged out"
 * is what sends an agent off to create a second profile and a second account.
 *
 * Stripping is safe: the result is only ever compared against the allowlist, so
 * it can change an answer only for names whose stem is already a known auth
 * cookie.
 */
function unchunk(name) {
  return name.replace(/\.\d+$/, '');
}

/**
 * The `__Host-` / `__Secure-` prefix, removed.
 *
 * Same failure as chunking: the name on disk is not the name in the list. The
 * prefixes are set by the *server* as a scoping guarantee, so a site can adopt
 * them without renaming anything — `__Host-JSESSIONID` is still JSESSIONID, and
 * matching the bare name missed it. Princeton's Shibboleth IdP ships
 * `__Host-shib_idp_session` for the same reason.
 */
function unprefix(name) {
  return name.replace(/^__(?:Host|Secure)-/, '');
}

/**
 * Names whose stem is fixed but whose tail is generated per deployment, so they
 * can only be matched by prefix. Shibboleth SPs append a hex-encoded entityID:
 * `_shibsession_64656661756c74...`.
 */
const AUTH_COOKIE_PREFIXES = ['_shibsession_', '_saml_idp', 'ps_token'];

/**
 * The allowlist put through the same normalisation as the name being tested.
 *
 * Both sides have to be normalised, not just the input: several entries carry a
 * `__Secure-`/`__Host-` prefix themselves, so stripping only the input turned
 * `__Secure-authjs.session-token` into a name that no longer matched its own
 * list entry — breaking the chunked-cookie case this file already had a test for.
 */
const AUTH_COOKIES_NORMALISED = new Set(
  [...AUTH_COOKIES].map((n) => unprefix(n).toLowerCase())
);

/** Does this cookie name mean "there is a session here"? */
export function isAuthCookie(name) {
  // Lowercased, because the same cookie is spelled `session` by one framework
  // and `SESSION` by another (Spring, on fed.princeton.edu).
  const stem = unprefix(unchunk(name)).toLowerCase();
  if (AUTH_COOKIES_NORMALISED.has(stem)) return true;
  return AUTH_COOKIE_PREFIXES.some((p) => stem.startsWith(p));
}

/** Chrome stores times as microseconds since 1601-01-01. */
function chromeNow() {
  return (Date.now() + 11644473600000) * 1000;
}

/**
 * Does this cookie *behave* like a session cookie, whatever it is called?
 *
 * The shape is the part that generalises. A credential a server wants back on
 * the next request is HttpOnly (so page scripts cannot read or steal it) and
 * Secure (so it never crosses plaintext), and one that should survive a browser
 * restart is persistent and unexpired. Analytics, consent and A/B cookies fail
 * the first test almost without exception, because their whole purpose is to be
 * read by front-end JavaScript.
 *
 * Requiring persistence is deliberate rather than incidental: the question a
 * caller is really asking is "will I still be logged in when I open this
 * profile", and a session-scoped cookie is gone by then anyway.
 */
export function looksLikeSessionCookie({ name, httponly, secure, persistent, expires }) {
  // Durability first, and it is a gate rather than one vote among several: a
  // cookie that does not outlive the browser cannot answer "will I still be
  // logged in next time", whatever it is called. This is the half that a name
  // list gets wrong in the *other* direction — chsi.com.cn was reported as
  // logged in off a session-scoped JSESSIONID that had died days earlier.
  if (!persistent || expires <= chromeNow()) return false;
  // Then either signal will do. The name list catches durable credentials that
  // are readable by page scripts; the shape catches everything not on it.
  // Known false positives: WAF and bot-management cookies (`__cf_bm`, `acw_tc`)
  // are HttpOnly, Secure and persistent too. They expire within the hour, so
  // they surface only right after a visit, and this column is evidence for a
  // human or agent to weigh, not a verdict — a stray host costs a glance, while
  // a missing one costs a duplicate profile.
  return isAuthCookie(name) || (httponly && secure);
}

/**
 * Read each cookie's host, name, and the flags that describe its shape.
 *
 * Still no `encrypted_value` — the added columns are booleans and an expiry, so
 * this cannot surface a credential even by accident. The DB is opened through a
 * `file:` URI with `immutable=1` because Chrome holds a write lock while it
 * runs, and a plain open on a live profile fails with SQLITE_BUSY.
 *
 * `name` is read last: a cookie name may itself contain the `|` separator (Duo
 * ships `browsertrust|<device>|<txn>`), so splitting from the left would truncate
 * it and splitting the whole line would produce phantom fields.
 */
function cookieHosts(profileDir) {
  const db = join(profileDir, 'Default', 'Cookies');
  if (!existsSync(db)) return [];
  try {
    const out = execFileSync(
      'sqlite3',
      [
        `file:${db}?mode=ro&immutable=1`,
        'select host_key, is_httponly, is_secure, is_persistent, expires_utc, name from cookies;',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [host, httponly, secure, persistent, expires, ...rest] = line.split('|');
        return {
          host: (host ?? '').replace(/^\./, ''),
          name: rest.join('|'),
          httponly: httponly === '1',
          secure: secure === '1',
          persistent: persistent === '1',
          expires: Number(expires ?? 0),
        };
      });
  } catch {
    // A profile mid-write, a schema we don't know, or no sqlite3 — report the
    // profile without login info rather than failing the whole listing.
    return [];
  }
}

/**
 * Hosts in this profile that look like they hold a durable session.
 *
 * Matching on cookie names alone was wrong in both directions at once: it missed
 * every Entra / Shibboleth / PeopleSoft login (those names are on no list, and
 * `_shibsession_<hex>` cannot be on one), and it simultaneously reported
 * chsi.com.cn as logged in off a JSESSIONID that had died with the browser days
 * before.
 */
function loggedInHosts(profileDir) {
  const named = new Set();
  const shaped = new Set();
  for (const cookie of cookieHosts(profileDir)) {
    if (!looksLikeSessionCookie(cookie)) continue;
    (isAuthCookie(cookie.name) ? named : shaped).add(cookie.host);
  }
  for (const h of named) shaped.delete(h);
  // Named first, because the listing only shows the first few hosts and the two
  // signals are not equally trustworthy. Shape alone has a large false-positive
  // class this ordering exists to demote: third-party ad and measurement domains
  // set HttpOnly, Secure, persistent cookies too, and on a well-used profile
  // there are dozens of them. Sorted alphabetically they buried the real logins
  // behind `1rx.io` and `360yield.com`.
  return [[...named].sort(), [...shaped].sort()].flat();
}

/**
 * Account labels Chrome already keeps in Default/Preferences.
 *
 * Only email strings are read. Tokens, Gaia credentials, and cookie values are
 * intentionally outside this path; this is identity evidence for the profile
 * inventory, not an authentication export.
 */
export function profileAccountEmails(profileDir) {
  try {
    const preferences = JSON.parse(
      readFileSync(join(profileDir, 'Default', 'Preferences'), 'utf8')
    );
    const records = Array.isArray(preferences?.account_info)
      ? preferences.account_info
      : Array.isArray(preferences?.profile?.account_info)
        ? preferences.profile.account_info
        : [];
    return [...new Set(
      records
        .map((record) => typeof record?.email === 'string' ? record.email.trim() : '')
        .filter(Boolean)
    )];
  } catch {
    return [];
  }
}

const MULTI_ACCOUNT_HOSTS = new Set([
  'accounts.google.com',
  'docs.google.com',
  'drive.google.com',
  'google.com',
  'mail.google.com',
]);

export function annotateLoginHosts(hosts, accountEmails) {
  return hosts.map((host) => {
    if (!MULTI_ACCOUNT_HOSTS.has(host)) return host;
    if (!accountEmails.length) return `${host} (multi-account: identity unknown)`;
    const more = accountEmails.length > 1 ? `, +${accountEmails.length - 1} more` : '';
    return `${host} (${accountEmails[0]}${more})`;
  });
}

function dirSizeMb(dir) {
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Math.round(parseInt(out.split(/\s+/)[0], 10) / 1024);
  } catch {
    return null;
  }
}

/** Chrome profile directories nested inside one web-plane user-data-dir. */
function innerChromeProfiles(dir) {
  const found = new Set();
  try {
    const state = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'));
    for (const name of Object.keys(state?.profile?.info_cache ?? {})) {
      if (existsSync(join(dir, name))) found.add(name);
    }
  } catch {}

  // Local State can lag a newly-created profile. The on-disk names are enough
  // to warn, while excluding Chrome's System Profile (not a human identity).
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name))) {
        found.add(entry.name);
      }
    }
  } catch {}

  return [...found].sort((a, b) => {
    if (a === 'Default') return -1;
    if (b === 'Default') return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

/**
 * Every profile that exists on disk, with whether a browser is live on it and
 * which sites it already holds a session for.
 */
export function listProfiles() {
  if (!existsSync(paths.profilesDir)) return [];
  const running = new Map(chromeProcs().filter((p) => p.session).map((p) => [p.session, p]));
  return readdirSync(paths.profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(paths.profilesDir, e.name);
      const proc = running.get(e.name);
      const chromeProfiles = innerChromeProfiles(dir);
      return {
        name: e.name,
        dir,
        running: Boolean(proc),
        pid: proc?.pid ?? null,
        port: proc?.port ?? null,
        sizeMb: dirSizeMb(dir),
        lastUsed: statSync(dir).mtime,
        logins: loggedInHosts(dir),
        accountEmails: profileAccountEmails(dir),
        chromeProfiles,
        profileSplit: chromeProfiles.length > 1,
      };
    })
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * `web-plane profiles`
 *
 * Exists because the question "which profile should I use?" had no honest answer
 * before: `web-plane list` is not a web-plane command at all — it falls through
 * to playwright-cli and prints *its* session registry, which lists names whose
 * profile dirs are long gone and omits profiles that were never opened through
 * playwright-cli. An agent that trusts it concludes the user's main profile does
 * not exist and creates a fresh logged-out one.
 *
 * This is an inventory, and deliberately only an inventory. It used to also take
 * `[site...]` and answer "which profile is logged into that site", which read as
 * a verdict and could not support one: cookie evidence is a guess in both
 * directions, and the two errors do not cost the same. A false "no profile holds
 * a session" is what sends an agent off to create the duplicate profile this
 * command exists to prevent — which is exactly what it did, on princeton.edu,
 * against a profile that was fully logged in. The reliable rule was never in the
 * cookie jar anyway: use the one identity profile the user already has.
 */
export function profiles() {
  const all = listProfiles();
  if (!all.length) {
    console.log(`No profiles yet in ${paths.profilesDir}`);
    return 0;
  }

  const width = Math.max(...all.map((p) => p.name.length), 7);
  const chromeProfile = (p) =>
    p.profileSplit
      ? `SPLIT: ${p.chromeProfiles.join(', ')}`
      : p.chromeProfiles[0] ?? '(none yet)';
  const chromeWidth = Math.max(...all.map((p) => chromeProfile(p).length), 15);
  console.log(
    `${'PROFILE'.padEnd(width)}  STATUS   SIZE   LAST USED     ` +
      `${'CHROME PROFILES'.padEnd(chromeWidth)}  LOGGED INTO (DEFAULT)`
  );
  for (const p of all) {
    const status = p.running ? 'running' : 'idle';
    const size = p.sizeMb == null ? '   -' : `${String(p.sizeMb).padStart(4)}M`;
    const last = p.lastUsed.toISOString().slice(0, 10);
    const annotatedLogins = annotateLoginHosts(p.logins, p.accountEmails);
    const logins = annotatedLogins.length
      ? annotatedLogins.slice(0, 4).join(', ') + (annotatedLogins.length > 4 ? ` +${annotatedLogins.length - 4}` : '')
      : '(none detected)';
    console.log(
      `${p.name.padEnd(width)}  ${status.padEnd(7)}  ${size}  ${last}    ` +
        `${chromeProfile(p).padEnd(chromeWidth)}  ${logins}`
    );
  }
  console.log(
    `\nLOGGED INTO (DEFAULT) is evidence, not a verdict — it reads only the Default\n` +
      `Chrome profile's cookies and account labels. A listed multi-account host\n` +
      `does not prove the identity you need is present; read a missing host as\n` +
      `"not detected", never as "logged out". Default to the user's one identity\n` +
      `profile; a second profile on the same account is a new device to the site.`
  );
  if (all.some((p) => p.profileSplit)) {
    console.log(
      `\nSPLIT means Chrome created multiple inner profiles inside one web-plane profile.\n` +
        `If more than one is live, show and CDP attach refuse rather than choosing the\n` +
        `wrong identity.`
    );
  }
  return 0;
}
