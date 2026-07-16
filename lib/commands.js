import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { paths } from './config.js';

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
 * Launch a hidden session (about:blank) for the given session name WITHOUT
 * exiting the process. Returns the child's exit status. Used by `cdp` so the
 * caller can then resolve and print the CDP port playwright-cli assigned.
 */
export function openHidden(session) {
  const pw = getPw();
  const profileDir = join(paths.profilesDir, session);
  mkdirSync(profileDir, { recursive: true });
  const args = [`-s=${session}`, '--headed', '--profile', profileDir];
  if (existsSync(paths.config)) args.push('--config', paths.config);
  const finalArgs = [pw, ...args, 'open', 'about:blank'];
  const result = spawnSync(finalArgs[0], finalArgs.slice(1), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}
