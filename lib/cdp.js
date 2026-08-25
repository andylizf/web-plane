import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { paths, MIN_AGENT_BROWSER } from './config.js';
import { openHidden } from './commands.js';
import { agentBrowserState, warnIfDegraded } from './health.js';
import { runAgentBrowser } from './agent-browser.js';
import { ensureInjectable } from './sign.js';
import { livePageContextIdsForPort, splitContextMessage } from './browser-contexts.js';
import {
  isCoveredClickFailure,
  parseSemanticFind,
  resolveSnapshotRole,
  translateLaneCommand,
} from './lane-commands.js';
import {
  canvasSnapshotHint,
  detectCanvasPage,
  dispatchFocusedKey,
  dispatchForcedClick,
  evalAllFrames,
  fieldChangeSummary,
  formatFrameEvalResults,
  parseAgentBrowserBox,
  parseAgentBrowserValueLength,
} from './page-diagnostics.js';
import { appendSessionEvent, sessionEvidencePaths } from './profile-runtime.js';
import {
  eventWarnings,
  laneCommandMayTriggerPageFailures,
  laneEventOffset,
  readLaneEventsAfter,
  runNetlog,
} from './lane-events.js';
import { startLaneMonitor, stopLaneMonitor } from './lane-monitor.js';
import { forgetLane, recallLane, rememberLane } from './lane-state.js';
import {
  blockedLaneResult,
  getUIStatus,
  laneCommandNeedsClearUI,
  newBlockers,
  rememberBlockerOwners,
} from './ui.js';

// One retry is what separates a transient launch race from a real breakage:
// enough to ride out the former, few enough that the latter still fails loudly
// instead of spinning.
const LAUNCH_ATTEMPTS = 2;
const PROFILE_LOCK_TIMEOUT_MS = 30_000;
const PROFILE_LOCK_POLL_MS = 25;
const PROFILE_LOCK_WRITE_GRACE_MS = 1_000;

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
  if (ensureInjectable()) {
    console.error('web-plane: clone Chrome was re-signed by an update — re-applied ad-hoc signature.');
  }
  if (!warnIfDegraded()) process.exit(1);
  session = session || 'default';

  let port = portForSession(session);
  let reused = Boolean(port);

  // A port found in `ps` can already be dead — the browser may have exited
  // between that read and now. Clear the corpse so the relaunch below starts
  // from a clean profile instead of racing its leftovers.
  if (reused && !(await cdpAlive(port))) {
    appendSessionEvent(session, { type: 'browser-disappeared', port, phase: 'reuse-check' });
    killSession(session);
    port = null;
    reused = false;
  }

  // Launch, cloak, and *verify* as one unit. Verification has to come after
  // the cloak, because that is where the browser has been observed dying:
  // everything before it looked healthy and the failure only surfaced later,
  // as a lane that could not be driven.
  for (let attempt = 1; !port && attempt <= LAUNCH_ATTEMPTS; attempt++) {
    appendSessionEvent(session, { type: 'launch-attempt', attempt });
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

    // Reassert the standing hidden state after Playwright's launch transition.
    // The injected hook already starts at alpha zero; this makes the post-launch
    // contract explicit and catches a missing signal path before returning a port.
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
    appendSessionEvent(session, { type: 'browser-disappeared', port, phase: 'post-launch', attempt });
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

  let contextIds;
  try {
    contextIds = await livePageContextIdsForPort(port);
  } catch (error) {
    console.error(
      `web-plane: refusing to expose CDP for session '${session}': could not verify its ` +
        `browser contexts (${error.message}).`
    );
    process.exit(1);
  }
  if (contextIds.length > 1) {
    console.error(`\n${splitContextMessage(session, 'attach to', contextIds.length)}\n`);
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
  console.log(`Attach:   web-plane agent-browser --session ${session} --pin-tab connect ${port}`);
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
export async function attach(session, urlOrArgs, lane = null) {
  session = session || 'default';
  lane = lane || session;
  const attachArgs = Array.isArray(urlOrArgs) ? urlOrArgs : [urlOrArgs].filter(Boolean);
  let navigation;
  try {
    navigation = translateLaneCommand(['open', ...attachArgs]);
  } catch (error) {
    console.error(`web-plane: ${error.message}`);
    process.exit(2);
  }
  if (navigation.args.length !== 2 || !navigation.args[1]) {
    console.error('Usage: web-plane -s=<profile> attach [--as <lane>] <url>');
    process.exit(1);
  }
  const url = navigation.args[1];

  const ab = agentBrowserState();
  if (!ab.installed) {
    console.error('web-plane: packaged agent-browser is missing or broken. Fix: reinstall web-plane');
    process.exit(1);
  }
  if (!ab.ok) {
    console.error(
      `\nweb-plane: agent-browser ${ab.version} is below the required ${MIN_AGENT_BROWSER}.\n` +
        `  This release lacks strict session-to-tab binding, so web-plane will not attach a lane.\n` +
        '  Fix: reinstall web-plane\n'
    );
    process.exit(1);
  }

  // Start a fresh browser on about:blank. The lane is created and navigated
  // below after its driver is connected, then the blank launch tab is closed.
  // Loading the destination here as well is redundant and makes driver attach
  // depend on that navigation. Connect first, then perform one owned navigation.
  const { port, reused } = await cdp(session);

  const drive = (args) =>
    runAgentBrowser(['--session', lane, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

  // Last gate before handing the port to agent-browser. On a dead port it does
  // not fail — it relaunches a browser of its own and succeeds at everything
  // afterwards, so a silent death in this window would surface much later as a
  // logged-out browser nobody can explain.
  if (!(await cdpAlive(port))) {
    const evidence = sessionEvidencePaths(session);
    appendSessionEvent(session, { type: 'browser-disappeared', port, phase: 'pre-attach', lane });
    console.error(
      `web-plane: the browser for session '${session}' died before lane '${lane}' could attach.\n` +
        `  Browser log: ${evidence.browserLog}\n` +
        `  Session events: ${evidence.eventsLog}\n` +
        `  Retry the attach; if it keeps happening, diagnose with: web-plane doctor`
    );
    process.exit(1);
  }

  // Attaching selects and navigates a tab too, so it shares the profile command
  // lock with established lanes. Otherwise a newly created lane can change
  // Chrome's selected tab halfway through another lane's native-UI boundary.
  let releaseLock;
  try {
    releaseLock = await acquireProfileCommandLock(session);
  } catch (error) {
    console.error(`web-plane: could not reserve Chrome profile '${session}': ${error.message}`);
    process.exit(1);
  }

  let attachError = null;
  try {
    // An explicit attach is also the recovery path after Chrome has restarted
    // and the old CDP target no longer exists. Clear any stale strict binding
    // for the connection only; the labelled-tab selection below enables it
    // again before any page operation can run.
    const connect = drive(['--no-pin-tab', 'connect', String(port)]);
    if (connect.status !== 0) {
      const message = connect.stderr?.trim() || 'unknown error';
      throw Object.assign(new Error(`Failed to attach agent-browser: ${message}`), {
        exitCode: connect.status ?? 1,
      });
    }

    // Claim this lane's tab. Re-attaching to a lane that already has one must
    // reuse it — otherwise every re-attach leaks a tab, which is how the stray
    // about:blank problem started in the first place.
    // agent-browser 0.34 persists this selected CDP target per named session.
    // Strict pinning is sticky: later commands and daemon restarts keep the
    // binding, and a closed target fails with tab_gone instead of adopting a
    // neighboring lane. This replaces web-plane's old pre-command tab switch,
    // which could preserve the right page only by discarding snapshot refs.
    const claimed = drive(['--pin-tab', 'tab', lane]);
    if (claimed.status !== 0) {
      // Create and label first, then navigate through `open` below so attach
      // does not return before the destination is ready.
      const tab = drive(['--pin-tab', 'tab', 'new', '--label', lane]);
      if (tab.status !== 0) {
        const message = tab.stderr?.trim() || 'unknown error';
        throw Object.assign(new Error(`Failed to open a tab: ${message}`), {
          exitCode: tab.status ?? 1,
        });
      }
      // A browser we just launched came up with a blank first tab; it is ours
      // to clean up, and leaving it is exactly the about:blank litter this
      // replaces.
      if (!reused) drive(['tab', 'close', 't1']);
    }

    const listing = drive(['tab', 'list', '--json']);
    const targetId = activeTargetId(listing.stdout);
    if (listing.status !== 0 || !targetId) {
      throw Object.assign(new Error(
        listing.stderr?.trim() || 'Failed to resolve the lane target for diagnostics'
      ), { exitCode: listing.status ?? 1 });
    }
    await startLaneMonitor({ lane, session, port, targetId });

    const nav = drive(navigation.args);
    if (nav.status !== 0) {
      const message = nav.stderr?.trim() || 'unknown error';
      throw Object.assign(new Error(`Failed to navigate: ${message}`), {
        exitCode: nav.status ?? 1,
      });
    }
    if (navigation.wait) {
      const waited = drive(navigation.wait);
      if (waited.status !== 0) {
        const message = waited.stderr?.trim() || 'readiness condition timed out';
        throw Object.assign(new Error(`Failed to wait for the page: ${message}`), {
          exitCode: waited.status ?? 1,
        });
      }
    }

    let target = { targetId };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      const pages = (await response.json()).filter((entry) => entry.type === 'page');
      const tabIndex = pages.findIndex((entry) => entry.id === targetId);
      const page = pages[tabIndex];
      if (page) target = { targetId, url: page.url, title: page.title, tabIndex };
    } catch {}
    rememberLane(lane, session, port, target);
  } catch (error) {
    stopLaneMonitor(lane);
    attachError = error;
  } finally {
    releaseLock();
  }

  if (attachError) {
    console.error(attachError.message);
    process.exit(attachError.exitCode ?? 1);
  }

  console.log(`Lane:     ${lane} (tab labelled '${lane}')`);
  console.log(`Drive:    web-plane lane ${lane} <command>`);
  console.log(`Binding:  pinned to this tab (agent-browser >= ${MIN_AGENT_BROWSER})`);
}

/**
 * `web-plane lane <lane> <agent-browser args...>`
 *
 * Run the command through the lane's persistent agent-browser target binding,
 * with web-plane's UI gate on both sides. attach enables strict --pin-tab once.
 * lane activates that same target in Chrome through CDP, but deliberately does
 * not select it again through agent-browser: CDP activation makes tab-scoped
 * native UI observable without invalidating refs from the preceding snapshot.
 */

/** The target id agent-browser marks active in a structured tab listing. */
export function activeTargetId(stdout) {
  try {
    const response = JSON.parse(stdout);
    const active = response?.data?.tabs?.find((tab) => tab.active === true);
    return typeof active?.targetId === 'string' && active.targetId ? active.targetId : null;
  } catch {
    return null;
  }
}

async function activateCdpTarget(port, targetId) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP version endpoint returned HTTP ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  if (!webSocketDebuggerUrl) throw new Error('CDP version endpoint returned no browser socket');

  const ws = new WebSocket(webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP browser socket did not open')), 2000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP browser socket failed to open'));
      }, { once: true });
    });
    await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error('Target.activateTarget timed out')), 2000);
      ws.addEventListener('message', function onMessage(event) {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve();
      });
      ws.send(JSON.stringify({ id, method: 'Target.activateTarget', params: { targetId } }));
    });
  } finally {
    ws.close();
  }
}

async function activateLaneTarget(name, port) {
  const listing = runAgentBrowser(
    ['--session', name, 'tab', 'list', '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  if (listing.status !== 0) {
    throw new Error(listing.stderr?.trim() || 'agent-browser could not list the lane target');
  }
  const targetId = activeTargetId(listing.stdout);
  if (!targetId) throw new Error('agent-browser reported no active pinned target');
  await activateCdpTarget(port, targetId);
  return targetId;
}

function profileCommandLockPath(session) {
  const key = createHash('sha256').update(session).digest('hex');
  return join(paths.runDir, `.profile-command-${key}.lock`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function staleProfileCommandLock(lockPath) {
  let ageMs;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }

  try {
    const state = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (processIsAlive(state.pid)) return false;
    // A creator can be between atomic open and writing its identity. Never
    // reclaim a just-created file merely because its contents are incomplete.
    return ageMs >= PROFILE_LOCK_WRITE_GRACE_MS;
  } catch {
    return ageMs >= PROFILE_LOCK_WRITE_GRACE_MS;
  }
}

async function acquireProfileCommandLock(session) {
  mkdirSync(paths.runDir, { recursive: true });
  const lockPath = profileCommandLockPath(session);
  const token = randomUUID();
  const deadline = Date.now() + PROFILE_LOCK_TIMEOUT_MS;

  while (true) {
    let fd = null;
    let created = false;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      created = true;
      writeFileSync(fd, JSON.stringify({ token, pid: process.pid, session, createdAt: Date.now() }));
      closeSync(fd);
      fd = null;
      return () => {
        try {
          const state = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (state.token === token) unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      if (created) {
        try { unlinkSync(lockPath); } catch {}
      }
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    if (staleProfileCommandLock(lockPath)) {
      try { unlinkSync(lockPath); } catch {}
      continue;
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `another command is still using Chrome profile '${session}' after ${PROFILE_LOCK_TIMEOUT_MS / 1000}s`
      );
      error.code = 'LANE_BUSY';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, PROFILE_LOCK_POLL_MS));
  }
}

function printUIResult(result) {
  console.error(JSON.stringify(result));
}

/** Parse the structured error buffer returned by agent-browser. */
export function parseAgentBrowserPageErrors(stdout) {
  const response = JSON.parse(stdout);
  if (response?.success !== true || !Array.isArray(response?.data?.errors)) {
    throw new Error('agent-browser returned no structured page-error list');
  }
  return response.data.errors.map((entry) => ({
    text: entry?.text ?? entry?.message ?? 'Unknown page error',
    url: entry?.url ?? null,
    line: entry?.line ?? null,
    column: entry?.column ?? null,
  }));
}

function runAgentBrowserLaneCommand(name, args) {
  // agent-browser 0.34/0.35 stores Runtime.exceptionThrown correctly, but its
  // plain formatter looks for `message` while the daemon returns `text`. Ask
  // for the stable JSON shape and render the buffer here so detached failures
  // do not become blank lines. Explicit JSON and --clear remain pass-throughs.
  if (args[0] === 'click') {
    const runCaptured = (commandArgs) => runAgentBrowser(['--session', name, ...commandArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    let result = runCaptured(args);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 && isCoveredClickFailure(output) && args[1]) {
      const scroll = runCaptured(['scrollintoview', args[1]]);
      if (scroll.status === 0) {
        console.error(`web-plane: '${args[1]}' was covered; centered it and retried once.`);
        result = runCaptured(args);
      }
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  }

  if (args[0] !== 'errors' || args.includes('--json') || args.includes('--clear')) {
    return runAgentBrowser(['--session', name, ...args], { stdio: 'inherit' });
  }

  const result = runAgentBrowser(['--session', name, '--json', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    return result;
  }

  try {
    const errors = parseAgentBrowserPageErrors(result.stdout ?? '');
    if (!errors.length) {
      console.log('No page errors.');
    } else {
      for (const error of errors) console.log(`✗ ${error.text}`);
    }
    return result;
  } catch (error) {
    console.error(`web-plane: could not read agent-browser's page-error buffer: ${error.message}`);
    if (result.stdout) process.stderr.write(result.stdout);
    return { ...result, status: 1 };
  }
}

function laneFieldLength(name, selector) {
  if (!selector) return null;
  const result = runAgentBrowser(
    ['--session', name, '--json', 'get', 'value', selector],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  return result.status === 0 ? parseAgentBrowserValueLength(result.stdout ?? '') : null;
}

function laneElementBox(name, selector) {
  if (!selector) return null;
  const result = runAgentBrowser(
    ['--session', name, '--json', 'get', 'box', selector],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  return result.status === 0 ? parseAgentBrowserBox(result.stdout ?? '') : null;
}

function runSemanticFind(name, args) {
  const plan = parseSemanticFind(args);
  const snapshot = runAgentBrowser(
    ['--session', name, 'snapshot'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  if (snapshot.status !== 0) {
    if (snapshot.stderr) process.stderr.write(snapshot.stderr);
    return snapshot;
  }
  const resolved = resolveSnapshotRole(snapshot.stdout, plan);
  if (!resolved) {
    console.error(
      `web-plane: no ${plan.role} named ${JSON.stringify(plan.name)} exists in the fresh snapshot`
    );
    return { status: 1 };
  }
  console.error(
    `web-plane: resolved ${plan.role} ${JSON.stringify(resolved.name)} to fresh ref ${resolved.ref}.`
  );
  if (plan.action === 'text') {
    return runAgentBrowserLaneCommand(name, ['get', 'text', resolved.ref]);
  }
  const command = [plan.action, resolved.ref, ...(plan.text === null ? [] : [plan.text])];
  const beforeLength = plan.action === 'fill' ? laneFieldLength(name, resolved.ref) : null;
  const result = runAgentBrowserLaneCommand(name, command);
  if ((result.status ?? 1) === 0 && plan.action === 'fill') {
    const afterLength = laneFieldLength(name, resolved.ref);
    console.error(`web-plane: ${fieldChangeSummary('replace', beforeLength, afterLength)}`);
  }
  return result;
}

function printTargetError(error, command, commandExecuted) {
  printUIResult({
    ok: false,
    error: {
      code: commandExecuted ? 'LANE_TARGET_UNAVAILABLE_AFTER_COMMAND' : 'LANE_TARGET_UNAVAILABLE',
      message: commandExecuted
        ? `'${command}' completed, but web-plane could not activate its pinned target: ${error.message}`
        : `web-plane could not activate the lane's pinned target: ${error.message}`,
      command,
      commandExecuted,
    },
  });
}

async function settledUIStatus(session, lane, before, retry) {
  const attempts = retry ? 3 : 1;
  let state = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    state = await getUIStatus(session, lane);
    if (!state.ok || newBlockers(before, state.blockers).length || attempt === attempts - 1) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return state;
}

async function runLaneCommand(name, args, known, port, operation, wait = null) {
  const monitorOffset = laneCommandMayTriggerPageFailures(args)
    ? laneEventOffset(known.session, name)
    : null;
  let targetActive = false;
  let targetId = null;
  try {
    targetId = await activateLaneTarget(name, port);
    targetActive = true;
  } catch (error) {
    // A tab command is the recovery surface for tab_gone: `tab list`, `tab new`,
    // or an explicit switch must remain available when no target can activate.
    if (args[0] !== 'tab') {
      printTargetError(error, args[0], false);
      return 1;
    }
  }

  const needsClearUI = laneCommandNeedsClearUI(args);
  const before = await getUIStatus(known.session, name);
  if (!before.ok && needsClearUI) {
    printUIResult({
      ...before,
      error: {
        ...before.error,
        code: 'UI_STATUS_UNAVAILABLE',
        message: `cannot prove page input is unblocked: ${before.error.message}`,
        command: args[0],
        commandExecuted: false,
      },
    });
    return 1;
  }
  if (before.ok && before.blockers.length && needsClearUI) {
    printUIResult(blockedLaneResult(args[0], before.blockers[0]));
    return 3;
  }
  if (before.ok && before.blockers.length) {
    console.error(JSON.stringify({
      ok: true,
      warning: {
        code: 'UI_BLOCKED',
        message: `blocking UI remains active while safe command '${args[0]}' runs`,
        blocker: before.blockers[0],
      },
    }));
  }

  const reportsField = ['append', 'clear', 'fill', 'replace'].includes(operation);
  const beforeLength = reportsField ? laneFieldLength(name, args[1]) : null;
  let result;
  if (operation === 'eval-all-frames') {
    try {
      const frames = await evalAllFrames(port, targetId, args[1]);
      console.log(formatFrameEvalResults(frames));
      result = { status: frames.some((frame) => frame.error) ? 1 : 0 };
    } catch (error) {
      console.error(`web-plane: all-frame eval failed: ${error.message}`);
      result = { status: 1 };
    }
  } else if (operation === 'key') {
    try {
      const dispatched = await dispatchFocusedKey(port, targetId, args[1]);
      console.error(`web-plane: key target: ${dispatched.description}`);
      console.log('✓ Done');
      result = { status: 0 };
    } catch (error) {
      console.error(`web-plane: key dispatch failed: ${error.message}`);
      result = { status: 1 };
    }
  } else if (operation === 'force-click') {
    const box = laneElementBox(name, args[1]);
    if (!box) {
      console.error(`web-plane: could not resolve a live bounding box for '${args[1]}'`);
      result = { status: 1 };
    } else {
      try {
        const forced = await dispatchForcedClick(port, targetId, box, args[1]);
        console.error(
          `web-plane: forced a real mouse click at the center of '${args[1]}'` +
            (forced.blockersBypassed
              ? ` after bypassing ${forced.blockersBypassed} covering element${forced.blockersBypassed === 1 ? '' : 's'}.`
              : '.')
        );
        console.log('✓ Done');
        result = { status: 0 };
      } catch (error) {
        console.error(`web-plane: forced click failed: ${error.message}`);
        result = { status: 1 };
      }
    }
  } else if (operation === 'semantic-find') {
    result = runSemanticFind(name, args);
  } else {
    result = runAgentBrowserLaneCommand(name, args);
  }
  const status = result.status ?? 1;
  if (status !== 0 || !before.ok) return status;

  if (reportsField) {
    const afterLength = laneFieldLength(name, args[1]);
    console.error(`web-plane: ${fieldChangeSummary(operation, beforeLength, afterLength)}`);
  }

  if (args[0] === 'snapshot' && targetId) {
    try {
      const hint = canvasSnapshotHint(await detectCanvasPage(port, targetId));
      if (hint) console.error(hint);
    } catch (error) {
      console.error(`web-plane: canvas detection unavailable: ${error.message}`);
    }
  }

  if (wait) {
    const waited = runAgentBrowserLaneCommand(name, wait);
    if ((waited.status ?? 1) !== 0) return waited.status ?? 1;
  }

  try {
    targetId = await activateLaneTarget(name, port);
    targetActive = true;
  } catch (error) {
    targetActive = false;
    if (args[0] !== 'tab') {
      printTargetError(error, args[0], true);
      return 1;
    }
  }
  // Closing or listing a gone tab can legitimately leave no active target.
  // There is then no tab-scoped UI to verify; the next page command will fail
  // before execution until a tab recovery command establishes a new binding.
  if (!targetActive) return status;

  const after = await settledUIStatus(known.session, name, before.blockers, needsClearUI);
  if (!after.ok) {
    if (needsClearUI) {
      printUIResult({
        ...after,
        error: {
          ...after.error,
          code: 'UI_STATUS_UNAVAILABLE_AFTER_COMMAND',
          message: `'${args[0]}' completed, but web-plane could not verify whether blocking UI appeared: ${after.error.message}`,
          command: args[0],
          commandExecuted: true,
        },
      });
      return 1;
    }
    return status;
  }

  const appeared = newBlockers(before.blockers, after.blockers);
  if (appeared.length) {
    rememberBlockerOwners(known.session, name, appeared);
    printUIResult(blockedLaneResult(args[0], appeared[0], { commandExecuted: true }));
    return 3;
  }
  if (monitorOffset != null) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const warnings = eventWarnings(readLaneEventsAfter(known.session, name, monitorOffset));
    if (warnings.length) {
      console.error(
        `web-plane: page reported ${warnings.length} failure${warnings.length === 1 ? '' : 's'} after '${args[0]}':\n` +
          warnings.map((warning) => `  - ${warning}`).join('\n') +
          `\n  Inspect: web-plane lane ${name} netlog --failed`
      );
    }
  }
  return status;
}

export async function lane(name, args) {
  if (!name || !args.length) {
    console.error('Usage: web-plane lane <lane> <agent-browser args...>');
    process.exit(1);
  }
  let translated;
  try {
    translated = translateLaneCommand(args);
    args = translated.args;
  } catch (error) {
    console.error(`web-plane: ${error.message}`);
    process.exit(2);
  }

  // The mapping is the proof that this agent-browser session belongs to a
  // web-plane Chrome. Without it, agent-browser may launch its own browser and
  // make a command look successful against the wrong identity.
  const known = recallLane(name);
  if (!known?.session) {
    console.error(
      `web-plane: lane '${name}' has no web-plane session mapping — attach it first:\n` +
        `  web-plane -s=<profile> attach --as ${name} <url>`
    );
    process.exit(1);
  }
  if (translated.operation === 'netlog') {
    const result = runNetlog(known.session, name, args);
    (result.status === 0 ? console.log : console.error)(result.output);
    process.exit(result.status);
  }
  const port = portForSession(known.session);
  if (!port) {
    const evidence = sessionEvidencePaths(known.session);
    appendSessionEvent(known.session, { type: 'browser-disappeared', lane: name, phase: 'lane-command' });
    console.error(
      `web-plane: the browser behind lane '${name}' (session '${known.session}') is no longer running.\n` +
        `  Browser log: ${evidence.browserLog}\n` +
        `  Session events: ${evidence.eventsLog}\n` +
        `  Re-attach it: web-plane -s=${known.session} attach --as ${name} <url>`
    );
    process.exit(1);
  }
  if (port !== known.port) {
    console.error(
      `web-plane: the browser behind lane '${name}' restarted on a new CDP port.\n` +
        `  Its old pinned tab no longer exists; web-plane will not guess a replacement.\n` +
        `  Re-attach it: web-plane -s=${known.session} attach --as ${name} <url>`
    );
    process.exit(1);
  }

  // agent-browser pins each lane independently, but Chrome has only one selected
  // tab. Keep target activation, both UI gates, and the command atomic so a
  // neighboring lane cannot hide the native UI this boundary must observe.
  let releaseLock;
  try {
    releaseLock = await acquireProfileCommandLock(known.session);
  } catch (error) {
    printUIResult({
      ok: false,
      error: {
        code: error.code === 'LANE_BUSY' ? 'LANE_BUSY' : 'LANE_LOCK_UNAVAILABLE',
        message: error.message,
        command: args[0],
        commandExecuted: false,
      },
    });
    process.exit(1);
  }

  let status;
  try {
    status = await runLaneCommand(name, args, known, port, translated.operation, translated.wait);
  } finally {
    releaseLock();
  }
  if (status === 0 && translated.operation === 'close-lane') {
    stopLaneMonitor(name);
    forgetLane(name);
  }
  process.exit(status);
}
