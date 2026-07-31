import { mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A scratch directory inside the repo, never /tmp.
 *
 * These tests build whole fake $HOME trees (a cloned Chrome, a compiled dylib, a
 * cookie database). Keeping them under the repo means a failed run leaves the
 * evidence somewhere you can still find it, and `git status` shows anything a
 * test forgot to clean up.
 */
export function makeTmpDir(name) {
  const dir = join(REPO_ROOT, 'tmp', `${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTmpDir(dir) {
  if (!dir || !dir.startsWith(join(REPO_ROOT, 'tmp'))) {
    throw new Error(`refusing to remove ${dir}: not inside the repo's tmp/`);
  }
  rmSync(dir, { recursive: true, force: true });
}
