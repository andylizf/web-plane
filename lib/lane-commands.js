const NAVIGATION_COMMANDS = new Set(['goto', 'navigate', 'open']);
const LOAD_STATES = new Set(['load', 'domcontentloaded', 'networkidle']);
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

export const PROXY_COMMANDS = new Set([
  'check', 'click', 'close-all', 'console', 'cookie-clear', 'cookie-delete',
  'cookie-get', 'cookie-list', 'cookie-set', 'delete-data', 'devtools-start',
  'dialog-accept', 'dialog-dismiss', 'dblclick', 'drag', 'eval', 'fill',
  'go-back', 'go-forward', 'goto', 'hover', 'install-browser', 'keydown',
  'keyup', 'kill-all', 'localstorage-clear', 'localstorage-delete',
  'localstorage-get', 'localstorage-list', 'localstorage-set', 'mousedown',
  'mousemove', 'mouseup', 'mousewheel', 'network', 'open', 'pdf', 'press',
  'reload', 'resize', 'route', 'route-list', 'run-code', 'screenshot',
  'select', 'sessionstorage-clear', 'sessionstorage-delete',
  'sessionstorage-get', 'sessionstorage-list', 'sessionstorage-set', 'snapshot',
  'state-load', 'state-save', 'tab-close', 'tab-list', 'tab-new', 'tab-select',
  'tracing-start', 'tracing-stop', 'type', 'uncheck', 'unroute', 'upload',
  'video-start', 'video-stop',
]);

function takeFlag(args, name) {
  const matches = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === name) {
      matches.push(true);
    } else if (value.startsWith(`${name}=`)) {
      matches.push(value.slice(name.length + 1));
    } else {
      rest.push(value);
    }
  }
  return { matches, rest };
}

function parseValueFlag(args, name) {
  const values = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === name) {
      if (i + 1 >= args.length) throw new Error(`${name} requires a value`);
      values.push(args[++i]);
    } else if (value.startsWith(`${name}=`)) {
      values.push(value.slice(name.length + 1));
    } else {
      rest.push(value);
    }
  }
  if (values.length > 1) throw new Error(`${name} may be supplied only once`);
  return { value: values[0] ?? null, rest };
}

function navigationWait(args) {
  const noWait = takeFlag(args, '--no-wait');
  if (noWait.matches.length > 1) throw new Error('--no-wait may be supplied only once');
  const waitFor = parseValueFlag(noWait.rest, '--wait-for');
  const timeout = parseValueFlag(waitFor.rest, '--timeout');
  if (noWait.matches.length && waitFor.value) {
    throw new Error('--no-wait cannot be combined with --wait-for');
  }
  const timeoutMs = timeout.value ?? String(DEFAULT_WAIT_TIMEOUT_MS);
  if (!/^\d+$/.test(timeoutMs) || Number(timeoutMs) <= 0) {
    throw new Error(`--timeout expects milliseconds, got '${timeoutMs}'`);
  }
  if (noWait.matches.length) return { args: timeout.rest, wait: null };
  const condition = waitFor.value ?? 'networkidle';
  const wait = LOAD_STATES.has(condition)
    ? ['wait', '--load', condition, '--timeout', timeoutMs]
    : ['wait', condition, '--timeout', timeoutMs];
  return { args: timeout.rest, wait };
}

export function parseSemanticFind(args) {
  if (args[0] !== 'find' || args[1] !== 'role' || !args[2]) return null;
  let name = null;
  let exact = false;
  const rest = [];
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--name') {
      if (name !== null || i + 1 >= args.length) throw new Error('--name requires one value');
      name = args[++i];
    } else if (args[i] === '--exact') {
      if (exact) throw new Error('--exact may be supplied only once');
      exact = true;
    } else {
      rest.push(args[i]);
    }
  }
  if (name === null) throw new Error("lane find role requires '--name <accessible-name>'");
  const action = rest[0] ?? 'click';
  if (!['check', 'click', 'fill', 'hover', 'text'].includes(action)) {
    throw new Error(`unsupported semantic find action '${action}'`);
  }
  if (action === 'fill' && rest.length !== 2) {
    throw new Error('semantic find fill requires exactly one text value');
  }
  if (action !== 'fill' && rest.length !== 1 && rest.length !== 0) {
    throw new Error(`semantic find ${action} takes no text value`);
  }
  return { role: args[2], name, exact, action, text: action === 'fill' ? rest[1] : null };
}

export function resolveSnapshotRole(snapshot, { role, name, exact = false }) {
  const wantedRole = role.toLowerCase();
  const wantedName = name.toLowerCase();
  for (const line of String(snapshot ?? '').split('\n')) {
    const match = line.match(/^\s*(?:-\s*)?([\w-]+)\s+"([^"]*)".*\bref=(e\d+)\b/i);
    if (!match || match[1].toLowerCase() !== wantedRole) continue;
    const candidate = match[2];
    const nameMatches = exact ? candidate === name : candidate.toLowerCase().includes(wantedName);
    if (nameMatches) return { ref: match[3], role: match[1], name: candidate };
  }
  return null;
}

export function translateLaneCommand(inputArgs) {
  const args = [...inputArgs];
  const command = args[0];

  if (command === 'type') {
    const append = takeFlag(args.slice(1), '--append');
    if (append.matches.length > 1) throw new Error('--append may be supplied only once');
    return {
      args: [append.matches.length ? 'type' : 'fill', ...append.rest],
      operation: append.matches.length ? 'append' : 'replace',
      wait: null,
    };
  }
  if (command === 'clear') {
    if (args.length !== 2) throw new Error('Usage: web-plane lane <lane> clear <selector>');
    return { args: ['fill', args[1], ''], operation: 'clear', wait: null };
  }
  if (command === 'click') {
    const force = takeFlag(args.slice(1), '--force');
    if (force.matches.length > 1) throw new Error('--force may be supplied only once');
    if (force.matches.length && force.rest.length !== 1) {
      throw new Error('Usage: web-plane lane <lane> click <selector> --force');
    }
    return {
      args: ['click', ...force.rest],
      operation: force.matches.length ? 'force-click' : 'click',
      wait: null,
    };
  }
  if (command === 'eval') {
    const allFrames = takeFlag(args.slice(1), '--all-frames');
    if (allFrames.matches.length > 1) throw new Error('--all-frames may be supplied only once');
    if (allFrames.matches.length && allFrames.rest.length !== 1) {
      throw new Error('Usage: web-plane lane <lane> eval --all-frames <expression>');
    }
    return {
      args: ['eval', ...allFrames.rest],
      operation: allFrames.matches.length ? 'eval-all-frames' : 'eval',
      wait: null,
    };
  }
  if (command === 'key' || command === 'press') {
    if (args.length !== 2) throw new Error('Usage: web-plane lane <lane> key <key-or-chord>');
    return { args: ['press', args[1]], operation: 'key', wait: null };
  }
  if (command === 'find' && args[1] === 'role') {
    parseSemanticFind(args);
    return { args, operation: 'semantic-find', wait: null };
  }
  if (command === 'close') {
    if (args.length !== 1) throw new Error("lane close takes no arguments; use the session-level 'web-plane -s=<profile> close' to close Chrome");
    return { args: ['tab', 'close'], operation: 'close-lane', wait: null };
  }
  if (command === 'keep' || command === 'unkeep') {
    if (args.length !== 1) throw new Error(`lane ${command} takes no arguments`);
    return {
      args: [],
      operation: command === 'keep' ? 'keep-lane' : 'unkeep-lane',
      wait: null,
    };
  }
  if (NAVIGATION_COMMANDS.has(command)) {
    const parsed = navigationWait(args.slice(1));
    return { args: [command, ...parsed.args], operation: 'navigate', wait: parsed.wait };
  }
  return { args, operation: command ?? null, wait: null };
}

export function isCoveredClickFailure(output) {
  return /\bis covered by\b.+\bat its click point\b/is.test(output ?? '');
}

export function laneHelp(version) {
  return `web-plane v${version} — lane commands

Usage: web-plane lane <lane> <command> [args]

Lane input:
  fill <selector> <text>       Replace existing field content (recommended)
  type <selector> <text>       Safe alias for fill; replacement is the default
  type <selector> <text> --append
                               Explicitly append real keystrokes
  clear <selector>             Clear a field, including one inside an iframe
  click <selector>             Click; centers and retries once if covered
  click <selector> --force     Deliberately send a real mouse click through an overlay
  find role <role> ...         Resolve by accessible role/name instead of stale refs
  scrollintoview <selector>    Center a target explicitly
  key|press <key>              Send a key and report the focused target

Navigation and readiness:
  navigate|goto|open <url>     Wait for network idle by default
    --wait-for <load|domcontentloaded|networkidle|selector>
    --timeout <ms> | --no-wait
  wait --load networkidle      Standalone readiness wait

Inspection and diagnosis:
  snapshot                     Accessibility tree plus current form-control state
  screenshot [path]            Read canvas-rendered pages visually
  eval <js>                    Evaluate in the top document
  eval --all-frames <js>       Return one result per frame
  console                      Buffered console messages
  errors                       Buffered uncaught page errors
  network requests             Buffered requests from agent-browser
  netlog --failed              Failed requests with CDP errorText

Lifecycle:
  close                        Close only this lane's tab; sibling lanes survive
  keep                         Exempt this lane from automatic reclamation
  unkeep                       Restore automatic reclamation for this lane

Hidden, clean lanes with no agent command for 24 hours are reclaimed as a crash backstop.
Test-only timing overrides: WEB_PLANE_LANE_TTL_MS and WEB_PLANE_REAP_INTERVAL_MS.

Selectors may be snapshot refs (@e3/e3), CSS, XPath, or semantic find locators.
Field writes read the same selector back and require an exact value match; password output is length-only.
Run 'web-plane agent-browser <command> --help' for the complete upstream surface.`;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export function nearestCommand(command, candidates) {
  const common = { tabs: 'tab-list' };
  if (common[command] && candidates.has(common[command])) return common[command];
  return [...candidates].sort((a, b) => editDistance(command, a) - editDistance(command, b) || a.localeCompare(b))[0] ?? null;
}
