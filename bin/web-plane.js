#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseInvocation, parseSessionFlag, parseLaneFlag } from '../lib/args.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Parse global flags (before command) and command + command args
const rawArgs = process.argv.slice(2);

// Our custom commands (not proxied to playwright-cli)
const CUSTOM_COMMANDS = new Set(['install', 'doctor', 'show', 'hide', 'toggle', 'status', 'close', 'cdp', 'attach', 'lane', 'profiles']);

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

const { command, globalArgs, commandArgs } = parseInvocation(rawArgs);

// Version before help: `--version` carries no command word, so a help check that
// only looked for a missing command answered it with the whole usage screen.
if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (!command || rawArgs.includes('--help') || rawArgs.includes('-h')) {
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
  fill <ref> <text>       Clear and fill input
  type <text>             Type into focused element
  press <key>             Press keyboard key
  hover <ref>             Hover over element
  eval <js>               Execute JavaScript
  close                   Close browser session
  ...                     All other playwright-cli commands are supported

Profiles (login identities):
  profiles [site...]      Every profile on disk: running/idle, size, and which
                          sites it already holds a session for. With a site,
                          answers "which profile is logged into x.com?".
                          Pick a profile by what's inside it, never by its name.

Window management:
  show                    Make browser window visible
  hide                    Make window invisible (screenshots still work)
  toggle                  Toggle window visibility
  status                  Show browser status (PID, visibility, session)

Integration (drive with agent-browser):
  attach [--as <lane>] <url>
                          One step: start/reuse a hidden session, open <url> in a
                          labelled tab, and connect an isolated agent-browser
                          session. Preferred over doing cdp + connect by hand.
                          -s picks the profile (login identity), --as picks the
                          lane. Concurrent agents on one identity: same -s,
                          different --as.
  lane <lane> <args...>   Run an agent-browser command against that lane's tab,
                          re-pinning it first. Use this instead of calling
                          agent-browser directly whenever a browser is shared —
                          any agent opening a tab moves everyone else's cursor.
  cdp [url]               Start/reuse a hidden session and print its CDP port
                          plus a ready 'agent-browser --session <name> connect' line

Flags:
  -s=<name>               Named session (persistent across commands)
  --profile <path>        Browser profile directory (default: ~/.web-plane/profiles/<session>)
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
  web-plane profiles                # which profile is already logged into what
  web-plane profiles x.com          # → the profile holding an x.com session
  web-plane -s=work attach https://example.com   # start + open + connect, one step
  web-plane cdp                     # then: agent-browser --session <name> connect <port>`);
  process.exit(0);
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
  lane(commandArgs[0], commandArgs.slice(1));
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
    console.log(`Window:        ${s.hidden ? 'hidden' : s.minimized ? 'minimized' : 'visible'}`);
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
  process.exit(profiles(commandArgs.filter((a) => !a.startsWith('-'))));
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
