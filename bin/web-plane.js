#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Parse global flags (before command) and command + command args
const rawArgs = process.argv.slice(2);

// Our custom commands (not proxied to playwright-cli)
const CUSTOM_COMMANDS = new Set(['install', 'show', 'hide', 'toggle', 'status', 'cdp']);

// Find the command: first non-flag argument
let commandIndex = -1;
let command = null;
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  // Skip flags and their values
  if (arg.startsWith('-')) {
    // -s=deep (flag with =) — no skip
    // -s deep (flag with space value) — skip next
    if (!arg.includes('=') && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
      i++; // skip value
    }
    continue;
  }
  command = arg;
  commandIndex = i;
  break;
}

const globalArgs = commandIndex > 0 ? rawArgs.slice(0, commandIndex) : [];
const commandArgs = commandIndex >= 0 ? rawArgs.slice(commandIndex + 1) : [];

function parseSessionFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-s=')) return args[i].slice(3);
    if (args[i] === '-s' && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

// Handle --help and --version
if (!command || rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`web-plane v${pkg.version} — ${pkg.description}

Usage: web-plane [flags] <command> [args]

Setup:
  install                 One-time setup (clone Chrome, compile DYLD hook, patch playwright)

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

Window management:
  show                    Make browser window visible
  hide                    Make window invisible (screenshots still work)
  toggle                  Toggle window visibility
  status                  Show browser status (PID, visibility, session)

Integration (drive with agent-browser):
  cdp                     Start/reuse a hidden session and print its CDP port
                          plus a ready 'agent-browser connect <port>' line

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
  web-plane cdp                     # then: agent-browser connect <port>`);
  process.exit(0);
}

if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

// Dispatch
if (command === 'install') {
  const { install } = await import('../lib/install.js');
  await install();
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
  } else {
    console.log('No browser session running.');
  }
} else if (command === 'cdp') {
  const { cdp } = await import('../lib/cdp.js');
  let session = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith('-s=')) session = a.slice(3);
    else if (a === '-s' && rawArgs[i + 1]) session = rawArgs[++i];
  }
  await cdp(session);
} else {
  // Proxy to playwright-cli
  const { runCommand } = await import('../lib/commands.js');
  runCommand(command, globalArgs, commandArgs);
}
