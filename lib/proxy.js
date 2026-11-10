/**
 * A profile's network exit.
 *
 * A proxy is part of a profile's identity, like its cookies: a site sees the
 * profile's IP as much as its login. So the proxy is stored per profile and
 * applied to every launch of that profile (attach, cdp, open, and the
 * relaunch that lane recovery does on its own). A browser that is running
 * with a different exit is refused. A flag that only applied to one launch
 * would let crash recovery bring the same profile back through the direct
 * exit without anyone asking.
 *
 * Chrome reads the proxy from `--proxy-server` and `--proxy-bypass-list` on its
 * command line, so the process table says which exit a running browser uses.
 * web-plane passes those two switches itself. Playwright's `proxy` launch
 * option would also add a `--host-resolver-rules` value wrapped in literal
 * quotes and a `<-loopback>` rule that sends localhost through the proxy, and
 * then the command line would no longer say only what the profile asked for.
 * Chrome's SOCKS5 resolves every name on the proxy's side by itself; the
 * integration test proves it with a host that cannot resolve locally.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';

// Chrome's own scheme names. `socks5h` is curl's spelling of SOCKS5 with
// proxy-side name resolution; Chrome's `socks5` already resolves every name
// proxy-side and has no `socks5h` scheme, so it is accepted and written as
// `socks5`. `socks4` resolves names locally and therefore leaks DNS; it is
// accepted because Chrome supports it, and `describeProxy` says so.
const SCHEMES = new Map([
  ['http:', 'http'],
  ['https:', 'https'],
  ['socks4:', 'socks4'],
  ['socks5:', 'socks5'],
  ['socks5h:', 'socks5'],
]);

/** The URL with any user:password replaced, for every message that names it. */
export function maskProxy(value) {
  if (value == null) return value;
  return String(value).replace(/^([a-z0-9+.-]+:\/\/)[^@/]*@/i, '$1***@');
}

/**
 * Validate a proxy URL and bypass list into the exact strings Chrome receives.
 *
 * Credentials are refused. Chrome ignores credentials in `--proxy-server` and
 * supports no authentication for SOCKS5 at all. It would answer an HTTP
 * proxy's 407 only through request interception by a driver, the interception
 * that stalled every tab (see driverEnvironment). An
 * authenticated upstream belongs behind a local forwarder such as `ssh -D`.
 */
export function parseProxy(value, bypass = null) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`proxy '${maskProxy(value)}' is not a URL; expected e.g. socks5://127.0.0.1:1080`);
  }
  const scheme = SCHEMES.get(url.protocol);
  if (!scheme) {
    throw new Error(
      `proxy scheme '${url.protocol.replace(/:$/, '')}' is not supported; use socks5, socks4, http or https`
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `proxy '${maskProxy(value)}' carries credentials, which Chrome cannot use on its command line ` +
        '(and not at all for SOCKS5). Run an unauthenticated local forwarder, e.g. ' +
        'ssh -N -D 127.0.0.1:<port> <host>, and give its address'
    );
  }
  if (!url.hostname || !url.port) {
    throw new Error(`proxy '${maskProxy(value)}' needs an explicit host and port`);
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`proxy '${maskProxy(value)}' must be scheme://host:port with nothing after it`);
  }
  if (bypass != null && (bypass === '' || /\s/.test(bypass))) {
    throw new Error(`proxy bypass list '${bypass}' must be non-empty with no spaces, e.g. '*.cn;10.0.0.0/8'`);
  }
  return { server: `${scheme}://${url.host}`, bypass: bypass ?? null };
}

/** The Chrome switches that select this exit. */
export function proxyChromeArgs(proxy) {
  if (!proxy) return [];
  return [
    `--proxy-server=${proxy.server}`,
    ...(proxy.bypass ? [`--proxy-bypass-list=${proxy.bypass}`] : []),
  ];
}

/** The exit a running Chrome was given, read back from its command line. */
export function proxyFromCommandLine(line) {
  const server = line.match(/(?:^|\s)--proxy-server=(\S+)/)?.[1] ?? null;
  if (!server) return null;
  return { server, bypass: line.match(/(?:^|\s)--proxy-bypass-list=(\S+)/)?.[1] ?? null };
}

export function sameProxy(a, b) {
  return (a?.server ?? null) === (b?.server ?? null) && (a?.bypass ?? null) === (b?.bypass ?? null);
}

/** One line naming the exit, never its credentials. */
export function describeProxy(proxy) {
  if (!proxy) return 'direct';
  const bypass = proxy.bypass ? ` (bypass ${proxy.bypass})` : '';
  const dns = proxy.server.startsWith('socks4:') ? ' [DNS resolved locally]' : '';
  return `${maskProxy(proxy.server)}${bypass}${dns}`;
}

export function profileProxyPath(session) {
  return join(paths.profileProxiesDir, `${encodeURIComponent(session)}.json`);
}

/** The exit stored for this profile, or null for direct. */
export function readProfileProxy(session) {
  const path = profileProxyPath(session);
  if (!existsSync(path)) return null;
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  return parseProxy(stored.server, stored.bypass ?? null);
}

export function writeProfileProxy(session, proxy) {
  const path = profileProxyPath(session);
  if (!proxy) {
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return path;
  }
  mkdirSync(paths.profileProxiesDir, { recursive: true, mode: 0o700 });
  const staged = `${path}.web-plane-staged`;
  writeFileSync(staged, JSON.stringify({ server: proxy.server, bypass: proxy.bypass }), { mode: 0o600 });
  renameSync(staged, path);
  return path;
}

/**
 * Why a running browser cannot serve this profile, or null when its exit is
 * the stored one. `running` is the parsed process (see parseChromeLine).
 */
export function proxyMismatch(session, running, stored = readProfileProxy(session)) {
  if (!running || sameProxy(running.proxy, stored)) return null;
  return (
    `profile '${session}' should exit through ${describeProxy(stored)}, but its running browser ` +
    `(pid ${running.pid}) was launched with ${describeProxy(running.proxy)}. web-plane will not reuse it, ` +
    `because its traffic would leave through the wrong exit.\n` +
    `  Restart it (this closes every lane on the profile): web-plane -s=${session} close, then retry.`
  );
}

/**
 * `--proxy <url>` and `--proxy-bypass <list>` out of a command's arguments.
 * Returns `proxy: undefined` when neither flag was given.
 */
export function takeProxyFlags(args) {
  const values = { '--proxy': [], '--proxy-bypass': [] };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const name = Object.keys(values).find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (!name) {
      rest.push(args[i]);
      continue;
    }
    if (arg === name) {
      if (i + 1 >= args.length) throw new Error(`${name} requires a value`);
      values[name].push(args[++i]);
    } else {
      values[name].push(arg.slice(name.length + 1));
    }
  }
  for (const [name, list] of Object.entries(values)) {
    if (list.length > 1) throw new Error(`${name} may be supplied only once`);
  }
  const [server] = values['--proxy'];
  const [bypass] = values['--proxy-bypass'];
  if (bypass !== undefined && server === undefined) throw new Error('--proxy-bypass needs --proxy');
  return { proxy: server === undefined ? undefined : parseProxy(server, bypass ?? null), rest };
}

/**
 * Make `requested` the profile's stored exit, for a command that asked for it
 * with `--proxy`. A running browser cannot change its exit, so a different
 * request while one runs is refused; with none running the request is stored,
 * and every later launch of the profile uses it until `proxy clear`.
 */
export function requireProfileProxy(session, requested, running) {
  const stored = readProfileProxy(session);
  if (sameProxy(stored, requested)) return { changed: false, proxy: stored };
  if (running) {
    throw new Error(
      `profile '${session}' has a browser running (pid ${running.pid}) with ${describeProxy(running.proxy)}; ` +
        `it cannot switch to ${describeProxy(requested)} while it runs.\n` +
        `  Restart it (this closes every lane on the profile): web-plane -s=${session} close, then retry.`
    );
  }
  writeProfileProxy(session, requested);
  return { changed: true, proxy: requested, previous: stored };
}
