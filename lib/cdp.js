import { execSync, spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths, MIN_AGENT_BROWSER } from './config.js';
import { openHidden } from './commands.js';
import { agentBrowserState } from './health.js';

/**
 * List running cloned-Chrome processes (one line each).
 */
function chromeLines() {
  try {
    return execSync(
      'ps aux | grep -i "Google Chrome" | grep -v grep | grep -v Helper',
      { encoding: 'utf8' }
    ).split('\n');
  } catch {
    return [];
  }
}

/**
 * Resolve the CDP tcp port for a session by matching its --user-data-dir
 * exactly (avoids prefix collisions like `agtest` vs `agtest2`).
 */
function portForSession(session) {
  const profileDir = join(paths.profilesDir, session);
  for (const line of chromeLines()) {
    const udd = line.match(/--user-data-dir=(\S+)/);
    const prt = line.match(/--remote-debugging-port=(\d+)/);
    if (udd && prt && udd[1] === profileDir) return parseInt(prt[1], 10);
  }
  return null;
}

/**
 * Remember which browser a lane was bound to.
 *
 * agent-browser keeps its own per-session connection. When the browser dies and
 * a new one takes its place, that connection survives as a handle to nothing:
 * commands then return empty strings — `document.readyState` "complete" with a
 * zero-length body — instead of failing. Recording (session, port) at attach
 * time lets `lane` notice the swap and rebind before it drives.
 */
function laneFile(name) {
  return join(paths.runtimeDir, 'lanes', `${name}.json`);
}

function rememberLane(name, session, port) {
  try {
    mkdirSync(join(paths.runtimeDir, 'lanes'), { recursive: true });
    writeFileSync(laneFile(name), JSON.stringify({ session, port }));
  } catch {}
}

function recallLane(name) {
  try {
    return JSON.parse(readFileSync(laneFile(name), 'utf8'));
  } catch {
    return null;
  }
}

function sleep(seconds) {
  try {
    execSync(`sleep ${seconds}`);
  } catch {}
}

/**
 * `web-plane cdp [-s=<name>]`
 *
 * Ensures a hidden session is running and prints the CDP port playwright-cli
 * assigned it, plus a ready-to-paste `agent-browser connect <port>` line. This
 * turns web-plane into a stealth-kernel provider: agent-browser (or any CDP
 * driver) does the operations, web-plane keeps ownership of show/hide/close.
 * The port is auto-assigned (playwright-cli allocates it and ignores any
 * pinned one), so read it from this command's output rather than hardcoding.
 */
export async function cdp(session, url = null) {
  session = session || 'default';

  let port = portForSession(session);
  const reused = Boolean(port);

  if (!port) {
    const status = openHidden(session, url ?? 'about:blank');
    if (status !== 0) {
      console.error(`Failed to start hidden session '${session}'.`);
      process.exit(status);
    }
    // Chrome may take a moment to expose the port; poll briefly.
    for (let i = 0; i < 10 && !port; i++) {
      sleep(0.3);
      port = portForSession(session);
    }
  }

  if (!port) {
    console.error(
      `Could not resolve a CDP port for session '${session}'. ` +
        `Is web-plane installed? Try: web-plane install`
    );
    process.exit(1);
  }

  // Whether this is a fresh browser or one that has been open for hours changes
  // what the caller should expect to find in it — say which.
  console.log(`Session:  ${session} (${reused ? 'reused, may already have tabs' : 'new'})`);
  console.log(`CDP port: ${port}`);
  // The --session flag is not decoration. agent-browser keys its daemon by that
  // name; every agent that omits it shares one daemon, and a second `connect`
  // against a daemon that already holds a browser is a silent no-op — the agent
  // ends up driving whichever browser got there first while believing it is in
  // its own session.
  console.log(`Attach:   agent-browser --session ${session} connect ${port}`);
  console.log(`Hide/show: web-plane -s=${session} hide | show`);
  return { session, port, reused };
}

/**
 * `web-plane -s=<profile> attach [--as <lane>] <url>`
 *
 * cdp + connect + navigate, as one step. Exists because doing it by hand has
 * three places to slip: forgetting `--session` (agents collide on one daemon),
 * landing on the stray about:blank instead of the page you wanted, and
 * hardcoding a port that changes every launch.
 *
 * `-s` and `--as` are deliberately separate axes:
 *   -s   picks the *profile* — the login identity, one Chrome process per Chrome
 *        allows exactly one of these (ProcessSingleton), and sharing it is what
 *        keeps a site seeing one device instead of N.
 *   --as picks the *lane* — one agent-browser daemon and one labelled tab inside
 *        that shared browser, so concurrent agents don't fight over a cursor.
 * Several agents on one identity is therefore: same -s, different --as.
 */
export async function attach(session, url, lane = null) {
  session = session || 'default';
  lane = lane || session;
  if (!url) {
    console.error('Usage: web-plane -s=<profile> attach [--as <lane>] <url>');
    process.exit(1);
  }

  const ab = agentBrowserState();
  if (!ab.installed) {
    console.error('agent-browser is not installed. Fix: npm i -g agent-browser');
    process.exit(1);
  }
  if (!ab.ok) {
    console.error(
      `\nweb-plane: WARNING — agent-browser ${ab.version} is below ${MIN_AGENT_BROWSER}.\n` +
        `  Concurrent sessions on one browser steal each other's active tab.\n` +
        `  Fix: npm i -g agent-browser@latest\n`
    );
  }

  const { port, reused } = await cdp(session, reusedLaneUrl(session, url));

  const drive = (args) =>
    spawnSync('agent-browser', ['--session', lane, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

  const connect = drive(['connect', String(port)]);
  if (connect.status !== 0) {
    console.error(`Failed to attach agent-browser: ${connect.stderr?.trim() || 'unknown error'}`);
    process.exit(connect.status ?? 1);
  }

  // Claim this lane's tab. Re-attaching to a lane that already has one must
  // reuse it — otherwise every re-attach leaks a tab, which is how the stray
  // about:blank problem started in the first place.
  const claimed = drive(['tab', lane]);
  if (claimed.status === 0) {
    const nav = drive(['open', url]);
    if (nav.status !== 0) {
      console.error(`Failed to navigate: ${nav.stderr?.trim() || 'unknown error'}`);
      process.exit(nav.status ?? 1);
    }
  } else {
    const tab = drive(['tab', 'new', '--label', lane, url]);
    if (tab.status !== 0) {
      console.error(`Failed to open a tab: ${tab.stderr?.trim() || 'unknown error'}`);
      process.exit(tab.status ?? 1);
    }
    // A browser we just launched came up with a blank first tab; it is ours to
    // clean up, and leaving it is exactly the about:blank litter this replaces.
    if (!reused) drive(['tab', 'close', 't1']);
  }

  rememberLane(lane, session, port);

  console.log(`Lane:     ${lane} (tab labelled '${lane}')`);
  console.log(`Drive:    agent-browser --session ${lane} <command>`);
  console.log(`Re-pin:   agent-browser --session ${lane} tab ${lane}   # after anyone opens a tab`);
}

// A brand-new browser can open the destination directly. A reused one must not:
// its first tab belongs to whoever is already working in it.
function reusedLaneUrl(session, url) {
  return portForSession(session) ? null : url;
}

/**
 * `web-plane lane <lane> <agent-browser args...>`
 *
 * Re-pin the lane's tab, then run the command against it.
 *
 * This exists because the re-pin is not a nicety. agent-browser keeps one
 * "active tab" per session, and *any* session opening a tab moves every other
 * session's pointer to it — and leaves it there. So two agents sharing a browser
 * silently converge onto one tab the first time either opens a link in a new
 * one, and from then on they overwrite each other's work.
 *
 * Asking agents to remember `tab <lane>` before every command is the kind of
 * discipline that holds until the one time it matters. Making it the default
 * costs one extra round-trip (single-digit ms against a warm daemon) and removes
 * the failure mode entirely.
 */
export function lane(name, args) {
  if (!name || !args.length) {
    console.error('Usage: web-plane lane <lane> <agent-browser args...>');
    process.exit(1);
  }
  // Rebind first if the browser this lane was attached to has been replaced.
  // Without this the stale connection answers every command with empty data and
  // the caller cannot tell "page is blank" from "browser is gone".
  const known = recallLane(name);
  if (known?.session) {
    const port = portForSession(known.session);
    if (!port) {
      console.error(
        `web-plane: the browser behind lane '${name}' (session '${known.session}') is no longer running.\n` +
          `  Re-attach it: web-plane -s=${known.session} attach --as ${name} <url>`
      );
      process.exit(1);
    }
    if (port !== known.port) {
      const rebind = spawnSync('agent-browser', ['--session', name, 'connect', String(port)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
      if (rebind.status !== 0) {
        console.error(
          `web-plane: lane '${name}' could not rebind to the restarted browser on port ${port}: ` +
            `${rebind.stderr?.trim() || 'unknown error'}`
        );
        process.exit(1);
      }
      rememberLane(name, known.session, port);
    }
  }

  const pin = spawnSync('agent-browser', ['--session', name, 'tab', name], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (pin.status !== 0) {
    console.error(
      `web-plane: lane '${name}' has no tab yet — attach it first:\n` +
        `  web-plane -s=<profile> attach --as ${name} <url>`
    );
    process.exit(1);
  }
  const result = spawnSync('agent-browser', ['--session', name, ...args], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
