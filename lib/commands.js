import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { paths } from './config.js';
import { ensureInjectable } from './sign.js';
import { warnIfDegraded, chromeProcs } from './health.js';

/**
 * Get the playwright-cli binary path. Exits if not installed.
 */
function getPw() {
  if (!existsSync(paths.pw)) {
    console.error('web-plane is not set up. Run: web-plane install');
    process.exit(1);
  }
  return paths.pw;
}

/**
 * Extract session name from args (e.g., -s=deep or -s deep)
 */
function parseSession(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-s=')) return args[i].slice(3);
    if (args[i] === '-s' && args[i + 1]) return args[i + 1];
  }
  return null;
}

/**
 * Extract --profile from args
 */
function parseProfile(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--profile=')) return args[i].split('=')[1];
  }
  return null;
}

/**
 * Check if args already contain a flag
 */
function hasFlag(args, flag) {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

/**
 * Run a playwright-cli command, proxying args.
 * For `open`, auto-injects --headed, --profile, --config.
 */
export function runCommand(command, globalArgs, commandArgs) {
  const pw = getPw();
  const allArgs = [...globalArgs];

  if (command === 'open') {
    // Auto-inject defaults for `open`
    if (!hasFlag(allArgs, '--headed') && !hasFlag(commandArgs, '--headed')) {
      allArgs.push('--headed');
    }

    // Auto-inject profile based on session name
    if (!parseProfile([...allArgs, ...commandArgs])) {
      const session = parseSession(allArgs) || 'default';
      const profileDir = join(paths.profilesDir, session);
      mkdirSync(profileDir, { recursive: true });
      allArgs.push('--profile', profileDir);
    }

    // Auto-inject config
    if (!hasFlag(allArgs, '--config') && !hasFlag(commandArgs, '--config')) {
      if (existsSync(paths.config)) {
        allArgs.push('--config', paths.config);
      }
    }
  }

  const finalArgs = [pw, ...allArgs, command, ...commandArgs];
  const result = spawnSync(finalArgs[0], finalArgs.slice(1), {
    stdio: 'inherit',
    env: process.env,
  });

  process.exit(result.status ?? 1);
}

/**
 * Launch a hidden session for the given session name WITHOUT exiting the
 * process. Returns the child's exit status. Used by `cdp` so the caller can then
 * resolve and print the CDP port playwright-cli assigned.
 *
 * `url` defaults to about:blank only because a browser needs *some* first page.
 * Pass the real destination when you have it: the blank tab is never cleaned up,
 * so every session started without one carries a stray about:blank forever, and
 * a driver attaching later can land on it instead of the page it wanted.
 */
export function openHidden(session, url = 'about:blank') {
  const pw = getPw();
  // Stealth is layered and every layer fails quietly; say so before launching
  // rather than letting a visible window be the first hint.
  warnIfDegraded();
  // A background Chrome update may have re-signed the clone and disabled dylib
  // injection; heal it before launch so the window never flashes.
  if (ensureInjectable()) {
    console.error('web-plane: clone Chrome was re-signed by an update — re-applied ad-hoc signature.');
  }
  const profileDir = join(paths.profilesDir, session);
  mkdirSync(profileDir, { recursive: true });
  const args = [`-s=${session}`, '--headed', '--profile', profileDir];
  if (existsSync(paths.config)) args.push('--config', paths.config);
  const finalArgs = [pw, ...args, 'open', url];
  const result = spawnSync(finalArgs[0], finalArgs.slice(1), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status === 0) verifyLaunchedClone(session);
  return result.status ?? 1;
}

/**
 * Confirm the process we just started is the cloned Chrome and not the system
 * one. The patch that redirects the launch is applied to a *third-party*
 * node_modules tree, so it can go missing between installs; when it does,
 * playwright falls back to `channel: 'chrome'` and everything still "works"
 * except the parts that made this tool worth using.
 */
function verifyLaunchedClone(session) {
  const proc = chromeProcs().find((p) => p.session === session);
  if (!proc || proc.managed) return;
  console.error(
    `\nweb-plane: WARNING — session '${session}' is running your SYSTEM Chrome, not the clone.\n` +
      `  No DYLD hook is loaded, so the window is visible and 'hide' can only minimize it.\n` +
      `  Fix: web-plane install   (diagnose with: web-plane doctor)\n`
  );
}
