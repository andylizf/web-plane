import { execSync, spawnSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths, MIN_AGENT_BROWSER } from './config.js';
import { openHidden } from './commands.js';
import { agentBrowserState } from './health.js';

// One retry is what separates a transient launch race from a real breakage:
// enough to ride out the former, few enough that the latter still fails loudly
// instead of spinning.
const LAUNCH_ATTEMPTS = 2;

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
 * Is a CDP endpoint actually answering on this port?
 *
 * `portForSession` only proves a browser was in `ps` at the instant we looked.
 * One that launched, published its port, and then exited leaves exactly that
 * evidence behind — and every layer downstream believes it. agent-browser
 * `connect` against a dead port quietly relaunches a browser of its own and
 * then reports success for every command that follows, so the caller drives a
 * different, logged-out Chrome while web-plane prints a ready-looking port.
 * Ask the endpoint itself rather than trusting the process table.
 */
async function cdpAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Remove a session's browser processes, including the helpers that share its
 * --user-data-dir. A half-dead launch left in place is what makes the *next*
 * attempt read a stale port out of `ps` instead of starting clean.
 */
function killSession(session) {
  const profileDir = join(paths.profilesDir, session);
  try {
    execSync(`pkill -f -- '--user-data-dir=${profileDir}'`, { stdio: 'ignore' });
  } catch {}

  // Whatever page took the browser down is still in the session-restore state,
  // so the next launch reopens it and dies exactly the same way. That loop is
  // self-sustaining: every retry re-poisons itself, the profile looks
  // permanently broken, and the symptom reads as "the launcher stopped working"
  // rather than "one page is fatal". Drop the restore state — the cost is a
  // forgotten tab list, the alternative is a profile that never comes back.
  const defaultDir = join(profileDir, 'Default');
  for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', 'Sessions']) {
    try {
      rmSync(join(defaultDir, f), { recursive: true, force: true });
    } catch {}
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
  let reused = Boolean(port);

  // A port found in `ps` can already be dead — the browser may have exited
  // between that read and now. Clear the corpse so the relaunch below starts
  // from a clean profile instead of racing its leftovers.
  if (reused && !(await cdpAlive(port))) {
    killSession(session);
    port = null;
    reused = false;
  }

  // Launch, cloak, and *verify* as one unit. Verification has to come after
  // the cloak, because that is where the browser has been observed dying:
  // everything before it looked healthy and the failure only surfaced later,
  // as a lane that could not be driven.
  for (let attempt = 1; !port && attempt <= LAUNCH_ATTEMPTS; attempt++) {
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
    if (!port) continue;

    // A fresh launch is only *minimized* — `openHidden` passes --start-minimized
    // and nothing else, so the window exists, sits in the Dock, and its minimize
    // animation is on screen. The real cloak (alpha 0, parked offscreen, and the
    // standing-hidden flag that makes later windows invisible too) lives in
    // windowControl and never ran. Do it here so hidden is genuinely the resting
    // state, instead of something every caller has to remember to ask for.
    const { windowControl } = await import('./window.js');
    try {
      await windowControl('hide', session);
    } catch (e) {
      console.error(`web-plane: could not hide the new window: ${e.message}`);
    }

    if (await cdpAlive(port)) break;

    console.error(
      `web-plane: session '${session}' published port ${port} and then went away` +
        (attempt < LAUNCH_ATTEMPTS ? ' — relaunching it.' : '.')
    );
    killSession(session);
    port = null;
  }

  if (!port) {
    console.error(
      `Could not bring up a live CDP endpoint for session '${session}' after ` +
        `${LAUNCH_ATTEMPTS} attempts. Diagnose with: web-plane doctor`
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

  // Last gate before handing the port to agent-browser. On a dead port it does
  // not fail — it relaunches a browser of its own and succeeds at everything
  // afterwards, so a silent death in this window would surface much later as a
  // logged-out browser nobody can explain.
  if (!(await cdpAlive(port))) {
    console.error(
      `web-plane: the browser for session '${session}' died before lane '${lane}' could attach.\n` +
        `  Retry the attach; if it keeps happening, diagnose with: web-plane doctor`
    );
    process.exit(1);
  }

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
/**
 * Is this lane's tab already the active one?
 *
 * `tab list` marks the active target with an arrow and prints each tab as
 * `[t<n>] <label> <title> - <url>`, so the token after the tab id is the lane
 * label when web-plane attached it. Unlike `tab <label>`, listing does not reset
 * the ref table, which is the whole point of asking.
 *
 * Returns false whenever the answer isn't clearly yes — an unparseable listing
 * or a missing session must fall through to pinning, because driving the wrong
 * tab is worse than losing refs.
 */
function laneIsActive(name) {
  const res = spawnSync('agent-browser', ['--session', name, 'tab', 'list'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout) return false;
  // eslint-disable-next-line no-control-regex
  const plain = res.stdout.replace(/\[[0-9;]*m/g, '');
  const active = plain.split('\n').find((l) => l.trimStart().startsWith('→'));
  if (!active) return false;
  return active.match(/\[t\d+\]\s+(\S+)/)?.[1] === name;
}

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

  // Re-pin only when the pointer actually moved. `tab <label>` clears the
  // snapshot ref table even when it re-selects the tab that was already active,
  // so pinning unconditionally made `lane snapshot` -> `lane click e3` — the
  // core driving loop, and the example in the skill — impossible: the pin in
  // front of the click threw away the refs the snapshot had just handed out.
  // `tab list` does not touch the ref table, so ask before acting.
  if (!laneIsActive(name)) {
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
  }
  const result = spawnSync('agent-browser', ['--session', name, ...args], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
