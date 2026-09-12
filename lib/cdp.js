import { execSync } from 'child_process';
import { join } from 'path';
import {
  AGENT_BROWSER_ATTACH_TIMEOUT_MS,
  paths,
  MIN_AGENT_BROWSER,
} from './config.js';
import { openHidden } from './commands.js';
import { agentBrowserState, warnIfDegraded } from './health.js';
import {
  agentBrowserSidecarPaths,
  normalizeSpawnTimeout,
  runAgentBrowser,
  stopAgentBrowserDaemon,
} from './agent-browser.js';
import { ensureInjectable } from './sign.js';
import { livePageContextIdsForPort, splitContextMessage } from './browser-contexts.js';
import {
  isCoveredClickFailure,
  parseAttachOptions,
  parseSemanticFind,
  resolveSnapshotRole,
  translateLaneCommand,
} from './lane-commands.js';
import {
  annotateSnapshotFormStates,
  canvasSnapshotHint,
  detectCanvasPage,
  dispatchFocusedKey,
  dispatchForcedClick,
  evalAllFrames,
  fieldReadbackResult,
  formatFrameEvalResults,
  parseAgentBrowserBox,
  parseAgentBrowserScalar,
  parseAgentBrowserValue,
  snapshotFormControls,
} from './page-diagnostics.js';
import {
  appendSessionEvent,
  quarantineChromeSessionState,
  sessionEvidencePaths,
} from './profile-runtime.js';
import {
  eventWarnings,
  laneCommandMayTriggerPageFailures,
  laneEventOffset,
  readLaneEventsAfter,
  runNetlog,
} from './lane-events.js';
import { startLaneMonitor, stopLaneMonitor } from './lane-monitor.js';
import { reconcileSessionLanes } from './lane-reconcile.js';
import { CdpConnection } from './cdp-client.js';
import {
  forgetLane,
  recallLane,
  rememberLane,
  touchLaneCommand,
} from './lane-state.js';
import { acquireProfileCommandLock } from './profile-command-lock.js';
import {
  listRestoredPageTargets,
  publicTarget,
  resolveRestoredTarget,
} from './lane-recovery.js';
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

function attachDriverTimeout(args) {
  if (args[0] !== 'wait') return AGENT_BROWSER_ATTACH_TIMEOUT_MS;
  const index = args.indexOf('--timeout');
  const requested = index >= 0 ? Number(args[index + 1]) : 0;
  return Number.isFinite(requested) && requested > 0
    ? requested + 5_000
    : AGENT_BROWSER_ATTACH_TIMEOUT_MS;
}

function attachDriverPhase(lane, args) {
  const index = args.findIndex((arg) => !String(arg).startsWith('-'));
  const command = index >= 0 ? args[index] : null;
  if (command === 'connect') return `agent-browser connect for lane '${lane}'`;
  if (command === 'tab') return `agent-browser tab ${args[index + 1] ?? 'operation'} for lane '${lane}'`;
  if (command === 'wait') return `agent-browser readiness wait for lane '${lane}'`;
  return `agent-browser ${command ?? 'command'} for lane '${lane}'`;
}

function runAttachDriver(session, lane, args, port = null) {
  const timeoutMs = attachDriverTimeout(args);
  const phase = attachDriverPhase(lane, args);
  let result = runAgentBrowser(['--session', lane, ...args], {
    cdpPort: port,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  result = normalizeSpawnTimeout(result, { phase, timeoutMs });
  if (result.timedOut) {
    appendSessionEvent(session, {
      type: 'driver-timeout',
      lane,
      phase,
      timeoutMs,
      command: args.find((arg) => !String(arg).startsWith('-')) ?? null,
    });
  }
  return result;
}

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
 * Ask the endpoint itself rather than trusting the process table, and require
 * Chrome's WebSocket descriptor rather than accepting an unrelated HTTP 200.
 */
export function isCdpVersionPayload(value) {
  if (typeof value?.webSocketDebuggerUrl !== 'string') return false;
  try {
    return new URL(value.webSocketDebuggerUrl).protocol === 'ws:';
  } catch {
    return false;
  }
}

async function cdpAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    return isCdpVersionPayload(await res.json());
  } catch {
    return false;
  }
}

/**
 * Remove a session's browser processes, including the helpers that share its
 * --user-data-dir. A half-dead launch left in place is what makes the *next*
 * attempt read a stale port out of `ps` instead of starting clean.
 */
function stopSessionProcesses(session) {
  const profileDir = join(paths.profilesDir, session);
  try {
    execSync(`pkill -f -- '--user-data-dir=${profileDir}'`, { stdio: 'ignore' });
  } catch {}
}

function quarantineFailedRestore(session, attempt, phase) {
  const result = quarantineChromeSessionState(session);
  if (!result.quarantine) return null;
  appendSessionEvent(session, {
    type: 'session-restore-quarantined',
    attempt,
    phase,
    backup: result.backup.dir,
    quarantine: result.quarantine,
    fileCount: result.files.length,
  });
  return result;
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
  session = session || 'default';
  const releaseLock = await acquireProfileCommandLock(session);
  try {
    return await resolveSessionCdp(session, url);
  } finally {
    releaseLock();
  }
}

async function resolveSessionCdp(session, url = null) {
  if (ensureInjectable()) {
    console.error('web-plane: clone Chrome was re-signed by an update — re-applied ad-hoc signature.');
  }
  if (!warnIfDegraded()) process.exit(1);
  session = session || 'default';

  let port = portForSession(session);
  let reused = Boolean(port);
  let sessionRestoreAttempted = false;

  // A port found in `ps` can already be dead — the browser may have exited
  // between that read and now. Clear the corpse so the relaunch below starts
  // from a clean profile instead of racing its leftovers.
  if (reused && !(await cdpAlive(port))) {
    appendSessionEvent(session, { type: 'browser-disappeared', port, phase: 'reuse-check' });
    stopSessionProcesses(session);
    port = null;
    reused = false;
  }

  // Launch, cloak, and *verify* as one unit. Verification has to come after
  // the cloak, because that is where the browser has been observed dying:
  // everything before it looked healthy and the failure only surfaced later,
  // as a lane that could not be driven.
  for (let attempt = 1; !port && attempt <= LAUNCH_ATTEMPTS; attempt++) {
    appendSessionEvent(session, { type: 'launch-attempt', attempt });
    const launch = openHidden(session, url);
    if (launch.sessionBackup) sessionRestoreAttempted = true;
    if (launch.status !== 0) {
      console.error(`Failed to start hidden session '${session}'.`);
      stopSessionProcesses(session);
      if (attempt < LAUNCH_ATTEMPTS && launch.sessionBackup) {
        try {
          quarantineFailedRestore(session, attempt, 'launch-failed');
        } catch (error) {
          console.error(`web-plane: could not secure failed Chrome restore: ${error.message}`);
          process.exit(1);
        }
        continue;
      }
      process.exit(launch.status);
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
    stopSessionProcesses(session);
    if (attempt < LAUNCH_ATTEMPTS && launch.sessionBackup) {
      try {
        quarantineFailedRestore(session, attempt, 'post-launch');
      } catch (error) {
        console.error(`web-plane: could not secure failed Chrome restore: ${error.message}`);
        process.exit(1);
      }
    }
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

  // Monitors die with the browser and native restore brings their tabs back
  // without them; re-arm them here so the idle backstop covers restored tabs,
  // and drop restored tabs no lane can ever rebind.
  await reconcileSessionLanes(session, port, { fresh: !reused, closeTarget: closePinnedLaneTarget });

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
  return { session, port, reused, sessionRestoreAttempted };
}

async function recoverLaneBinding(name, known) {
  const { port } = await resolveSessionCdp(known.session);
  let targets;
  try {
    targets = await listRestoredPageTargets(port);
  } catch (error) {
    console.error(`web-plane: Chrome restarted, but its restored tabs could not be inspected: ${error.message}`);
    return 1;
  }
  const resolution = resolveRestoredTarget(known, targets);
  if (resolution.status !== 'matched') {
    appendSessionEvent(known.session, {
      type: 'lane-restore-unresolved',
      lane: name,
      reason: resolution.reason,
      candidateCount: resolution.candidates.length,
    });
    const candidates = resolution.candidates
      .map((target) => publicTarget(target, target.tabIndex))
      .map((target) => `    [${target.index}] ${target.url}`)
      .join('\n');
    console.error(
      `web-plane: Chrome restarted, but lane '${name}' could not be rebound safely ` +
        `(${resolution.reason}).\n` +
        (candidates ? `  Matching restored tabs:\n${candidates}\n` : '') +
        `  Attach it explicitly: web-plane -s=${known.session} attach --as ${name} <url>`
    );
    return 1;
  }

  const target = resolution.target;
  const drive = (args) => runAttachDriver(known.session, name, args, port);
  const connect = drive(['--no-pin-tab', 'connect', String(port)]);
  if (connect.status !== 0) {
    console.error(`web-plane: Chrome restored lane '${name}', but its driver could not reconnect: ` +
      (connect.stderr?.trim() || 'unknown error'));
    return connect.status ?? 1;
  }
  const selected = drive(['--pin-tab', 'tab', target.id]);
  if (selected.status !== 0) {
    console.error(`web-plane: Chrome restored lane '${name}', but its tab could not be selected: ` +
      (selected.stderr?.trim() || 'unknown error'));
    return selected.status ?? 1;
  }
  const listing = drive(['tab', 'list', '--json']);
  if (listing.status !== 0 || activeTargetId(listing.stdout) !== target.id) {
    console.error(`web-plane: refusing lane '${name}' recovery because the driver did not retain ` +
      `the restored Chrome target.`);
    return 1;
  }

  stopLaneMonitor(name);
  await startLaneMonitor({ lane: name, session: known.session, port, targetId: target.id });
  rememberLane(name, known.session, port, {
    targetId: target.id,
    url: target.url,
    title: target.title,
    tabIndex: target.tabIndex,
  });
  appendSessionEvent(known.session, {
    type: 'lane-restored',
    lane: name,
    port,
    targetId: target.id,
  });
  console.error(
    `web-plane: restored lane '${name}' with Chrome's saved session.\n` +
      '  The previous command was not replayed; take a fresh snapshot, then run it again.'
  );
  return 0;
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
 *   -s   picks the *profile* — the login identity, one browser instance per
 *        user-data-dir. Chrome allows exactly one (ProcessSingleton), and
 *        sharing it is what keeps a site seeing one device instead of N.
 *   --as picks the *lane* — one agent-browser daemon and one labelled tab inside
 *        that shared browser, so concurrent agents don't fight over a cursor.
 * Several agents on one identity is therefore: same -s, different --as.
 */
export async function attach(session, urlOrArgs, lane = null) {
  session = session || 'default';
  lane = lane || session;
  if (!agentBrowserSidecarPaths(lane)) {
    console.error(
      `web-plane: lane '${lane}' is not safe for agent-browser runtime files; ` +
      'use letters, numbers, dots, underscores, or hyphens'
    );
    process.exit(2);
  }
  const attachArgs = Array.isArray(urlOrArgs) ? urlOrArgs : [urlOrArgs].filter(Boolean);
  let navigation;
  let webauthnDisabled;
  try {
    const options = parseAttachOptions(attachArgs);
    webauthnDisabled = options.webauthnDisabled;
    navigation = translateLaneCommand(['open', ...options.args], { defaultWaitFor: 'load' });
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

  // Reserve the profile before resolving or launching Chrome: the last lane's
  // reaper may be shutting down the previous empty browser under this lock.
  let releaseLock;
  try {
    releaseLock = await acquireProfileCommandLock(session);
  } catch (error) {
    console.error(`web-plane: could not reserve Chrome profile '${session}': ${error.message}`);
    process.exit(1);
  }

  // Start a fresh browser on about:blank. The lane is created and navigated
  // below after its driver is connected, then the blank launch tab is closed.
  // Loading the destination here as well is redundant and makes driver attach
  // depend on that navigation. Connect first, then perform one owned navigation.
  const { port, reused } = await resolveSessionCdp(session);

  const drive = (args) => runAttachDriver(session, lane, args, port);

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
  // Chrome's active target halfway through another lane's native-UI boundary.
  let attachError = null;
  let registered = false;
  let createdTab = false;
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

    // agent-browser excludes Chrome's New Tab page and may create about:blank
    // while connecting. Capture both startup pages after connect, before the
    // lane is created. Preserve reused browsers and any restored real pages.
    const launchPages = !reused
      ? await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      }).then(response => response.json())
      : [];
    const pages = launchPages.filter(target => target.type === 'page');
    const launchPageIds = pages.every(target => ['about:blank', 'chrome://newtab/'].includes(target.url))
      ? pages.map(target => target.id) : [];

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
      createdTab = true;
      // A browser we just launched came up with a blank first tab; it is ours
      // to clean up, and leaving it is exactly the about:blank litter this
      // replaces.
      for (const initialTargetId of launchPageIds) {
        await closePinnedLaneTarget(port, initialTargetId);
      }
    }

    const listing = drive(['tab', 'list', '--json']);
    const targetId = activeTargetId(listing.stdout);
    if (listing.status !== 0 || !targetId) {
      throw Object.assign(new Error(
        listing.stderr?.trim() || 'Failed to resolve the lane target for diagnostics'
      ), { exitCode: listing.status ?? 1 });
    }
    // Keep the tab reachable even if navigation or readiness fails.
    rememberLane(lane, session, port, { targetId, webauthnDisabled });
    touchLaneCommand(lane);
    registered = true;
    await startLaneMonitor({ lane, session, port, targetId });

    const nav = drive(navigation.args);
    if (nav.status !== 0) {
      const message = nav.stderr?.trim() || 'unknown error';
      throw Object.assign(new Error(`Failed to navigate: ${message}`), {
        exitCode: nav.status ?? 1,
      });
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
    touchLaneCommand(lane);
  } catch (error) {
    if (!registered) {
      if (createdTab) drive(['tab', 'close']);
      stopLaneMonitor(lane);
    }
    attachError = error;
  } finally {
    releaseLock();
  }

  // The driver is pinned to this target. Observing readiness cannot switch a
  // sibling's active target and does not need the profile's native-UI lock.
  if (!attachError && navigation.wait) {
    const waited = drive(navigation.wait);
    if (waited.status !== 0) {
      const message = waited.stderr?.trim() || 'readiness condition timed out';
      attachError = Object.assign(new Error(
        `Failed to wait for the page: ${message}\n` +
        '  Choose --wait-for load|domcontentloaded|networkidle|<selector>, ' +
        '--timeout <ms>, or --no-wait.'
      ), { exitCode: waited.status ?? 1 });
    }
  }

  if (attachError) {
    if (!registered) await stopAgentBrowserDaemon(lane);
    console.error(attachError.message);
    if (registered) {
      console.error(`Lane '${lane}' remains attached. Inspect with: web-plane lane ${lane} snapshot\n` +
        `  Close with: web-plane lane ${lane} close`);
    }
    process.exit(attachError.exitCode ?? 1);
  }

  console.log(`Lane:     ${lane} (tab labelled '${lane}')`);
  console.log(`Drive:    web-plane lane ${lane} <command>`);
  console.log(`Binding:  pinned to this tab (agent-browser >= ${MIN_AGENT_BROWSER})`);
  if (webauthnDisabled) console.log('WebAuthn: disabled for this lane; use an alternate sign-in method');
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
  const active = JSON.parse(listing.stdout).data.tabs.find((tab) => tab.targetId === targetId);
  console.error(JSON.stringify({
    type: 'lane-source', lane: name, targetId, url: active.url ?? null, phase: 'before-command',
  }));
  return targetId;
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

function capturedLaneCommand(name, args) {
  return runAgentBrowser(
    ['--session', name, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
}

function writeCapturedOutput(result, { suppressDone = false } = {}) {
  let stdout = result.stdout ?? '';
  if (suppressDone) {
    stdout = stdout
      .split('\n')
      .filter((line) => line.trim() !== '✓ Done')
      .join('\n');
  }
  if (stdout && stdout !== '\n') process.stdout.write(stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function laneFieldValue(name, selector) {
  if (!selector) return null;
  const result = runAgentBrowser(
    ['--session', name, '--json', 'get', 'value', selector],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  return result.status === 0 ? parseAgentBrowserValue(result.stdout ?? '') : null;
}

function laneFieldIsPassword(name, selector) {
  if (!selector) return true;
  const result = runAgentBrowser(
    ['--session', name, '--json', 'get', 'attr', selector, 'type'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  if (result.status !== 0) return true;
  const parsed = parseAgentBrowserScalar(result.stdout ?? '');
  if (!parsed.ok) return true;
  return String(parsed.value ?? '').toLowerCase() === 'password';
}

function laneFieldChecked(name, selector) {
  if (!selector) return null;
  const result = runAgentBrowser(
    ['--session', name, '--json', 'is', 'checked', selector],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  if (result.status !== 0) return null;
  const parsed = parseAgentBrowserScalar(result.stdout ?? '');
  return parsed.ok && typeof parsed.value === 'boolean' ? parsed.value : null;
}

function verifyFieldWrite(name, selector, operation, input, before, password, result) {
  if ((result.status ?? 1) !== 0) {
    writeCapturedOutput(result);
    return result;
  }
  const after = laneFieldValue(name, selector);
  const readback = fieldReadbackResult({ operation, before, input, after, password });
  writeCapturedOutput(result, { suppressDone: true });
  console.error(`web-plane: ${readback.message}`);
  return readback.ok ? result : { ...result, status: 1 };
}

function runSnapshotWithFormState(name, args) {
  const snapshot = capturedLaneCommand(name, args);
  if ((snapshot.status ?? 1) !== 0) {
    writeCapturedOutput(snapshot);
    return snapshot;
  }

  const states = [];
  for (const control of snapshotFormControls(snapshot.stdout ?? '')) {
    if (['checkbox', 'radio', 'switch'].includes(control.role)) {
      const checked = laneFieldChecked(name, control.ref);
      if (checked === null) {
        console.error(`web-plane: could not read checked state for snapshot ref ${control.ref}`);
      } else {
        states.push({ ref: control.ref, kind: 'checked', checked });
      }
      continue;
    }
    const value = laneFieldValue(name, control.ref);
    if (value === null) {
      console.error(`web-plane: could not read field value for snapshot ref ${control.ref}`);
      continue;
    }
    states.push({
      ref: control.ref,
      kind: 'value',
      value,
      password: ['textbox', 'searchbox'].includes(control.role)
        ? laneFieldIsPassword(name, control.ref)
        : false,
    });
  }

  const stdout = annotateSnapshotFormStates(snapshot.stdout ?? '', states);
  if (stdout) process.stdout.write(stdout);
  if (snapshot.stderr) process.stderr.write(snapshot.stderr);
  return { ...snapshot, stdout };
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
  if (plan.action !== 'fill') return runAgentBrowserLaneCommand(name, command);
  const before = laneFieldValue(name, resolved.ref);
  const password = laneFieldIsPassword(name, resolved.ref);
  const result = capturedLaneCommand(name, command);
  return verifyFieldWrite(
    name,
    resolved.ref,
    'replace',
    plan.text,
    before,
    password,
    result
  );
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

async function closePinnedLaneTarget(port, targetId) {
  if (!targetId) throw new Error('lane has no pinned target to close');
  const connection = await CdpConnection.connect(port);
  let targetDestroyed = false;
  connection.onEvent(message => {
    if (message.method === 'Target.targetDestroyed' && message.params?.targetId === targetId) {
      targetDestroyed = true;
    }
  });
  try {
    await connection.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos: before = [] } = await connection.send(
      'Target.getTargets',
      {},
      null,
      2_000
    );
    if (!before.some((target) => target.targetId === targetId)) return;

    const result = await connection.send(
      'Target.closeTarget',
      { targetId },
      null,
      5_000
    );
    if (result?.success === false) throw new Error('Chrome refused to close the lane target');

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const { targetInfos = [] } = await connection.send(
        'Target.getTargets',
        {},
        null,
        2_000
      );
      if (!targetInfos.some((target) => target.targetId === targetId)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('lane target was still present after Chrome reported it closed');
  } catch (error) {
    // The final page can close Chrome before the confirmation query returns.
    if (!targetDestroyed) throw error;
  } finally {
    connection.close();
  }
}

async function runLaneCommand(name, args, known, port, operation, wait = null) {
  const monitorOffset = laneCommandMayTriggerPageFailures(args)
    ? laneEventOffset(known.session, name)
    : null;
  let targetActive = false;
  let targetId = known?.targetId ?? null;
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
  const beforeValue = reportsField ? laneFieldValue(name, args[1]) : null;
  const passwordField = reportsField ? laneFieldIsPassword(name, args[1]) : false;
  let result;
  if (operation === 'close-lane') {
    try {
      await closePinnedLaneTarget(port, targetId);
      console.log('✓ Done');
      result = { status: 0 };
    } catch (error) {
      console.error(`web-plane: lane close failed: ${error.message}`);
      result = { status: 1 };
    }
  } else if (operation === 'eval-all-frames') {
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
  } else if (operation === 'snapshot') {
    result = runSnapshotWithFormState(name, args);
  } else if (reportsField) {
    result = capturedLaneCommand(name, args);
  } else {
    result = runAgentBrowserLaneCommand(name, args);
  }
  if (reportsField) {
    result = verifyFieldWrite(
      name,
      args[1],
      operation,
      args[2] ?? '',
      beforeValue,
      passwordField,
      result
    );
  }
  const status = result.status ?? 1;
  if (status !== 0 || !before.ok) return status;
  if (operation === 'close-lane') return status;

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
  let known = recallLane(name);
  if (!known?.session) {
    console.error(
      `web-plane: lane '${name}' has no web-plane session mapping — attach it first:\n` +
        `  web-plane -s=<profile> attach --as ${name} <url>`
    );
    process.exit(1);
  }
  touchLaneCommand(name);
  if (translated.operation === 'netlog') {
    const result = runNetlog(known.session, name, args);
    (result.status === 0 ? console.log : console.error)(result.output);
    process.exit(result.status);
  }
  let port = portForSession(known.session);
  if (!port || port !== known.port) {
    appendSessionEvent(known.session, { type: 'browser-disappeared', lane: name, phase: 'lane-command' });
    let releaseRecoveryLock;
    try {
      releaseRecoveryLock = await acquireProfileCommandLock(known.session);
      const status = await recoverLaneBinding(name, known);
      process.exitCode = status;
    } catch (error) {
      console.error(`web-plane: lane '${name}' recovery failed: ${error.message}`);
      process.exitCode = 1;
    } finally {
      if (releaseRecoveryLock) releaseRecoveryLock();
    }
    return;
  }

  // agent-browser pins each lane independently, but Chrome-owned UI follows the
  // active tab and window. Keep target activation, both UI gates, and the command
  // atomic so a neighboring lane cannot hide the native UI this boundary observes.
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
    if (status === 0 && translated.operation === 'close-lane') {
      const daemon = await stopAgentBrowserDaemon(name);
      if (daemon.stopped) {
        stopLaneMonitor(name);
        forgetLane(name);
      } else {
        console.error(
          `web-plane: lane target closed, but driver cleanup failed (${daemon.reason}); ` +
          'the lane mapping was retained so cleanup can be retried'
        );
        status = 1;
      }
    }
  } finally {
    touchLaneCommand(name);
    releaseLock();
  }
  process.exit(status);
}
