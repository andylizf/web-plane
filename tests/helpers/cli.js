import { spawnSync } from 'child_process';
import { join } from 'path';
import { REPO_ROOT } from './tmpdir.js';

export const CLI = join(REPO_ROOT, 'bin', 'web-plane.js');

/**
 * Run the CLI the way a user does — as its own process, so exit codes and the
 * stdout/stderr split are the real ones. `home` redirects everything the tool
 * reads and writes under `~/.web-plane`, which is what makes it safe to run
 * against a machine that has real sessions open.
 */
export function runCli(args, { home, env = {} } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(home ? { HOME: home } : {}), ...env },
  });
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    all: (res.stdout ?? '') + (res.stderr ?? ''),
  };
}
