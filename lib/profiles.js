import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { paths } from './config.js';
import { chromeProcs } from './health.js';

/**
 * Cookie names that mean "this profile holds a live session for that host".
 * Presence is a strong hint, not proof — a stale cookie survives a logout on the
 * server side — so callers should treat the answer as "start here", not "you are
 * logged in". Absence is the reliable direction: no auth cookie means a login is
 * definitely needed.
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

/** Does this cookie name mean "there is a session here"? */
export function isAuthCookie(name) {
  return AUTH_COOKIES.has(unchunk(name));
}

/**
 * The profiles holding a session for any of `sites`, each tagged with which of
 * its hosts matched.
 *
 * Suffix matching, so `x.com` finds `api.x.com` — the cookie is on whatever
 * host set it, and asking for the site people say out loud must not miss the
 * subdomain the login actually lives on. It also means `x.com` will not match
 * `notx.com` only because the leading dot of a domain cookie is stripped first.
 */
export function profilesForSites(all, sites) {
  const wanted = sites.map((s) => s.replace(/^\./, '').toLowerCase());
  return all
    .map((p) => ({
      ...p,
      matched: p.logins.filter((h) =>
        wanted.some((w) => {
          const host = h.toLowerCase();
          return host === w || host.endsWith(`.${w}`);
        })
      ),
    }))
    .filter((p) => p.matched.length);
}

/**
 * Read (host, cookie-name) pairs out of a profile's cookie DB.
 *
 * Only `host_key` and `name` are ever selected — `encrypted_value` is not read,
 * so this cannot surface a credential even by accident. The DB is opened through
 * a `file:` URI with `immutable=1` because Chrome holds a write lock while it
 * runs, and a plain open on a live profile fails with SQLITE_BUSY.
 */
function cookieHosts(profileDir) {
  const db = join(profileDir, 'Default', 'Cookies');
  if (!existsSync(db)) return [];
  try {
    const out = execFileSync(
      'sqlite3',
      [`file:${db}?mode=ro&immutable=1`, 'select host_key, name from cookies;'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [host, name] = line.split('|');
        return { host: (host ?? '').replace(/^\./, ''), name: name ?? '' };
      });
  } catch {
    // A profile mid-write, a schema we don't know, or no sqlite3 — report the
    // profile without login info rather than failing the whole listing.
    return [];
  }
}

/** Hosts in this profile that carry a known session cookie. */
function loggedInHosts(profileDir) {
  const hosts = new Set();
  for (const { host, name } of cookieHosts(profileDir)) {
    if (isAuthCookie(name)) hosts.add(host);
  }
  return [...hosts].sort();
}

function dirSizeMb(dir) {
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Math.round(parseInt(out.split(/\s+/)[0], 10) / 1024);
  } catch {
    return null;
  }
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
      return {
        name: e.name,
        dir,
        running: Boolean(proc),
        pid: proc?.pid ?? null,
        port: proc?.port ?? null,
        sizeMb: dirSizeMb(dir),
        lastUsed: statSync(dir).mtime,
        logins: loggedInHosts(dir),
      };
    })
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * `web-plane profiles [site...]`
 *
 * Exists because the question "which profile is already logged into X?" had no
 * answer before: `web-plane list` is not a web-plane command at all — it falls
 * through to playwright-cli and prints *its* session registry, which lists names
 * whose profile dirs are long gone and omits profiles that were never opened
 * through playwright-cli. An agent that trusts it concludes the user's main
 * profile does not exist and creates a fresh logged-out one.
 */
export function profiles(sites = []) {
  const all = listProfiles();
  if (!all.length) {
    console.log(`No profiles yet in ${paths.profilesDir}`);
    return 0;
  }

  if (sites.length) {
    const hits = profilesForSites(all, sites);
    if (!hits.length) {
      console.log(`No profile holds a session for: ${sites.join(', ')}`);
      console.log(`A login is needed. Pick the identity profile you already use, not a new one:`);
      for (const p of all.slice(0, 5)) {
        console.log(`  ${p.name}${p.logins.length ? `  (logged into ${p.logins.length} site(s))` : '  (empty)'}`);
      }
      return 1;
    }
    for (const p of hits) {
      console.log(`${p.name}${p.running ? ' (running)' : ''} — ${p.matched.join(', ')}`);
    }
    return 0;
  }

  const width = Math.max(...all.map((p) => p.name.length), 7);
  console.log(`${'PROFILE'.padEnd(width)}  STATUS   SIZE   LAST USED     LOGGED INTO`);
  for (const p of all) {
    const status = p.running ? 'running' : 'idle';
    const size = p.sizeMb == null ? '   -' : `${String(p.sizeMb).padStart(4)}M`;
    const last = p.lastUsed.toISOString().slice(0, 10);
    const logins = p.logins.length ? p.logins.slice(0, 4).join(', ') + (p.logins.length > 4 ? ` +${p.logins.length - 4}` : '') : '(none detected)';
    console.log(`${p.name.padEnd(width)}  ${status.padEnd(7)}  ${size}  ${last}    ${logins}`);
  }
  console.log(
    `\nPick by what is inside a profile, never by its name. Reuse the identity the\n` +
      `user already has; a second profile on the same account is a new device to the\n` +
      `site. Narrow to one site with: web-plane profiles x.com`
  );
  return 0;
}
