import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { paths } from './config.js';
import {
  appendSessionEvent,
  ensureManagedLaunchConfig,
  prepareManagedProfile,
  prepareSessionLogs,
} from './profile-runtime.js';
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

  let launchEnv = process.env;
  if (command === 'open') {
    if (ensureInjectable()) {
      console.error('web-plane: clone Chrome was re-signed by an update — re-applied ad-hoc signature.');
    }
    if (!warnIfDegraded()) process.exit(1);
    // Auto-inject defaults for `open`
    if (!hasFlag(allArgs, '--headed') && !hasFlag(commandArgs, '--headed')) {
      allArgs.push('--headed');
    }

    // Auto-inject profile based on session name
    const requestedProfile = parseProfile([...allArgs, ...commandArgs]);
    if (!requestedProfile) {
      const session = parseSession(allArgs) || 'default';
      const profileDir = join(paths.profilesDir, session);
      mkdirSync(profileDir, { recursive: true });
      allArgs.push('--profile', profileDir);
      if (!chromeProcs().some((proc) => proc.session === session)) {
        const prepared = prepareManagedProfile(session);
        ensureManagedLaunchConfig();
        const evidence = prepareSessionLogs(session);
        appendSessionEvent(session, { type: 'launch-requested', command: 'open' });
        if (prepared.sessionBackup) {
          appendSessionEvent(session, {
            type: 'session-restore-backup',
            backup: prepared.sessionBackup.dir,
            fileCount: prepared.sessionBackup.files.length,
          });
        }
        launchEnv = { ...process.env, CHROME_LOG_FILE: evidence.browserLog };
      }
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
    env: launchEnv,
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
  // Heal a clone re-signed by Chrome's updater before the health gate checks it.
  // Doing these in the opposite order refuses the launch before the built-in
  // repair gets a chance to run.
  if (ensureInjectable()) {
    console.error('web-plane: clone Chrome was re-signed by an update — re-applied ad-hoc signature.');
  }
  // Stealth is layered and every layer fails quietly; say so before launching
  // rather than letting a visible window be the first hint.
  if (!warnIfDegraded()) return 1;
  const profileDir = join(paths.profilesDir, session);
  mkdirSync(profileDir, { recursive: true });
  const prepared = prepareManagedProfile(session);
  ensureManagedLaunchConfig();
  const evidence = prepareSessionLogs(session);
  appendSessionEvent(session, { type: 'launch-requested', command: 'open-hidden', url });
  if (prepared.sessionBackup) {
    appendSessionEvent(session, {
      type: 'session-restore-backup',
      backup: prepared.sessionBackup.dir,
      fileCount: prepared.sessionBackup.files.length,
    });
  }
  const args = [`-s=${session}`, '--headed', '--profile', profileDir];
  if (existsSync(paths.config)) args.push('--config', paths.config);
  const finalArgs = [pw, ...args, 'open', url];
  const result = spawnSync(finalArgs[0], finalArgs.slice(1), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CHROME_LOG_FILE: evidence.browserLog },
  });
  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status === 0) verifyLaunchedClone(session);
  return { status: result.status ?? 1, sessionBackup: prepared.sessionBackup };
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
