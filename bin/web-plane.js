#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseInvocation, parseSessionFlag, parseLaneFlag, stripSessionFlag } from '../lib/args.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Parse global flags (before command) and command + command args
const rawArgs = process.argv.slice(2);

// Our custom commands (not proxied to playwright-cli)
const CUSTOM_COMMANDS = new Set(['install', 'doctor', 'show', 'hide', 'toggle', 'status', 'close', 'cdp', 'attach', 'lane', 'profiles', 'panel', 'ui', 'agent-browser']);

// Commands playwright-cli answers about *itself*. Proxying them succeeds and
// prints something authoritative-looking that has nothing to do with web-plane:
// `list` is playwright-cli's own session registry, which keeps names whose
// profile dirs were deleted and omits profiles it never opened. Believing it
// costs a real login — you conclude the user's profile isn't there and start a
// fresh logged-out one. Refuse instead of answering wrongly.
const MISLEADING_PROXIES = {
  list: {
    instead: 'web-plane profiles',
    why: "prints playwright-cli's session registry, not web-plane profiles",
  },
};

const { command, commandIndex, globalArgs, commandArgs } = parseInvocation(rawArgs);
const webPlaneFlagArgs = commandIndex >= 0 ? rawArgs.slice(0, commandIndex) : rawArgs;

// The Princeton VPN renewal daemon runs as root, while its browser is owned by
// the console user's LaunchAgent.  A root-side `eval` cannot attach to that
// user session reliably: playwright-cli creates a separate root Chrome and an
// about:blank tab on each retry.  Refuse that one unsafe crossing at the
// web-plane boundary. Root may still close/status the session during cleanup.
if (process.getuid?.() === 0 && command === 'eval' &&
    rawArgs.some((arg) => arg === '-s=princeton-vpn' || arg === '--session=princeton-vpn')) {
  console.error('web-plane: refusing root eval for session princeton-vpn; use its user LaunchAgent');
  process.exit(1);
}

// Version before help: `--version` carries no command word, so a help check that
// only looked for a missing command answered it with the whole usage screen.
if (
  (command === 'agent-browser' ? webPlaneFlagArgs : rawArgs).some(
    (arg) => arg === '--version' || arg === '-v'
  )
) {
  console.log(pkg.version);
  process.exit(0);
}

if (
  !command ||
  (command === 'agent-browser' ? webPlaneFlagArgs : rawArgs).some(
    (arg) => arg === '--help' || arg === '-h'
  )
) {
  console.log(`web-plane v${pkg.version} — ${pkg.description}

Usage: web-plane [flags] <command> [args]

Setup:
  install                 One-time setup (clone Chrome, compile DYLD hook, patch playwright)
  doctor                  Check that stealth is actually in effect; print fixes

Browser control (proxied to playwright-cli):
  open <url>              Open URL (auto-injects --headed, --profile, --config)
  goto <url>              Navigate to URL
  snapshot                Accessibility tree with element refs (e1, e2...)
  screenshot [path]       Capture page as PNG
  click <ref>             Click element by ref
  fill <ref> <text>       Clear the field, then enter text — use this to REPLACE a value
  type <ref> <text>       Type text without clearing — APPENDS to what is already there
  press <key>             Press keyboard key
  hover <ref>             Hover over element
  eval <js>               Execute JavaScript
  close                   Close browser session
  ...                     All other playwright-cli commands are supported

Profiles (login identities):
  profiles                Every profile on disk: running/idle, size, and which
                          hosts it looks to hold a session for. An inventory, not
                          a verdict — read a missing host as "not detected", and
                          default to the one identity profile the user has.

Window management:
  show                    Make browser window visible
  hide                    Make window invisible (screenshots still work)
  toggle                  Toggle window visibility
  status                  Show browser status (PID, visibility, session)

Native Save/Open panels:
  panel status            Report the active Save/Open panel as JSON
  panel accept --path <absolute-path>
                          Select the exact path and press Save/Open
  panel cancel            Cancel the active Save/Open panel

Blocking UI:
  ui status               Report browser modals and native panels without
                          showing them or taking focus

Integration (drive with agent-browser):
  agent-browser <args...> Run web-plane's pinned agent-browser dependency. Use
                          this for a manual CDP connection; no separate install.
  attach [--as <lane>] <url>
                          One step: start/reuse a hidden session, open <url> in a
                          labelled tab, and connect an isolated agent-browser
                          session. Preferred over doing cdp + connect by hand.
                          -s picks the profile (login identity), --as picks the
                          lane. Concurrent agents on one identity: same -s,
                          different --as.
  lane <lane> <args...>   Run an agent-browser command against that lane's tab,
                          using its persistent pinned target and web-plane's UI
                          gate. Use this instead of calling agent-browser
                          directly so blocking native UI cannot go unnoticed.
  cdp [url]               Start/reuse a hidden session and print its CDP port
                          plus a ready pinned agent-browser connection line

Flags:
  -s=<name>               Named session (persistent across commands)
  --profile <path>        Playwright profile path (open/proxied commands only;
                          cdp/attach use -s=<name>)
  --help, -h              Show this help
  --version, -v           Show version

Examples:
  web-plane install
  web-plane open https://chatgpt.com
  web-plane -s=research open https://example.com
  web-plane -s=research snapshot
  web-plane -s=research click e3
  web-plane hide
  web-plane show
  web-plane doctor
  web-plane profiles                # inventory of profiles and what each holds
  web-plane -s=work attach https://example.com   # start + open + connect, one step
  web-plane cdp                     # then use the web-plane agent-browser line it prints`);
  process.exit(0);
}

// web-plane's own commands identify a browser by the session-owned profile at
// ~/.web-plane/profiles/<session>. Accepting an arbitrary path here would make
// launch use one profile while status, cdp discovery, and close look for
// another. Before this guard, a global --profile was silently ignored and a
// command-local one could even be mistaken for attach/cdp's URL.
if (
  CUSTOM_COMMANDS.has(command) && command !== 'agent-browser' &&
  rawArgs.some((arg) => arg === '--profile' || arg.startsWith('--profile='))
) {
  console.error(
    `web-plane: --profile is not supported by '${command}'. ` +
      'web-plane-managed profiles are selected with -s=<name>.'
  );
  process.exit(2);
}

// Dispatch
if (command === 'install') {
  const { install } = await import('../lib/install.js');
  await install();
} else if (command === 'doctor') {
  const { doctor } = await import('../lib/health.js');
  process.exit(doctor());
} else if (command === 'lane') {
  const { lane } = await import('../lib/cdp.js');
  await lane(commandArgs[0], commandArgs.slice(1));
} else if (command === 'agent-browser') {
  const { runAgentBrowser } = await import('../lib/agent-browser.js');
  const result = runAgentBrowser(commandArgs, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (command === 'attach') {
  const { attach } = await import('../lib/cdp.js');
  const { lane, rest } = parseLaneFlag(commandArgs);
  await attach(parseSessionFlag(rawArgs), rest[0], lane);
} else if (command === 'show' || command === 'hide' || command === 'toggle') {
  const { windowControl } = await import('../lib/window.js');
  await windowControl(command, parseSessionFlag(rawArgs));
} else if (command === 'status') {
  const { getStatus } = await import('../lib/window.js');
  const s = await getStatus(parseSessionFlag(rawArgs));
  if (s.running) {
    console.log(`Session:       ${s.session ?? '(unnamed)'}`);
    console.log(`Chrome PID:    ${s.pid}`);
    console.log(`CDP port:      ${s.port}`);
    console.log(`Window:        ${s.windowState}`);
    if (!s.managed) {
      console.log(
        `Suppression:   UNMANAGED — this Chrome was not launched by web-plane, so\n` +
          `               'hide' can only minimize it (visible in the Dock, still\n` +
          `               steals focus). Usually a leftover from a crashed session:\n` +
          `               web-plane -s=${s.session ?? '<name>'} close, then start it again.`
      );
    }
  } else {
    console.log('No browser session running.');
  }
} else if (command === 'close') {
  const { closeSession } = await import('../lib/window.js');
  process.exit(await closeSession(parseSessionFlag(rawArgs)));
} else if (command === 'cdp') {
  const { cdp } = await import('../lib/cdp.js');
  await cdp(parseSessionFlag(rawArgs), commandArgs[0] ?? null);
} else if (command === 'profiles') {
  const { profiles } = await import('../lib/profiles.js');
  process.exit(profiles());
} else if (command === 'panel') {
  const { runPanelCommand } = await import('../lib/panel.js');
  const result = await runPanelCommand(parseSessionFlag(rawArgs), stripSessionFlag(commandArgs));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} else if (command === 'ui') {
  const { runUICommand } = await import('../lib/ui.js');
  const result = await runUICommand(parseSessionFlag(rawArgs), stripSessionFlag(commandArgs));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} else if (MISLEADING_PROXIES[command]) {
  const { instead, why } = MISLEADING_PROXIES[command];
  console.error(
    `web-plane: '${command}' is not a web-plane command — it would proxy to playwright-cli, which\n` +
      `  ${why}.\n` +
      `  Use: ${instead}`
  );
  process.exit(2);
} else {
  // Proxy to playwright-cli
  const { runCommand } = await import('../lib/commands.js');
  runCommand(command, globalArgs, commandArgs);
}
