import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { paths } from './config.js';

const PROFILE_LOCK_POLL_MS = 25;
const PROFILE_LOCK_WRITE_GRACE_MS = 1_000;

export function profileCommandLockPath(session) {
  const key = createHash('sha256').update(session).digest('hex');
  return join(paths.runDir, `.profile-command-${key}.lock`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function staleProfileCommandLock(lockPath) {
  let ageMs;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }

  try {
    const state = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (processIsAlive(state.pid)) return false;
    // A creator can be between atomic open and writing its identity. Never
    // reclaim a just-created file merely because its contents are incomplete.
    return ageMs >= PROFILE_LOCK_WRITE_GRACE_MS;
  } catch {
    return ageMs >= PROFILE_LOCK_WRITE_GRACE_MS;
  }
}

export async function acquireProfileCommandLock(session, { timeoutMs = 30_000 } = {}) {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.runDir, 0o700);
  const lockPath = profileCommandLockPath(session);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let fd = null;
    let created = false;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      created = true;
      writeFileSync(fd, JSON.stringify({ token, pid: process.pid, session, createdAt: Date.now() }));
      closeSync(fd);
      fd = null;
      return () => {
        try {
          const state = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (state.token === token) unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      if (created) {
        try { unlinkSync(lockPath); } catch {}
      }
      if (error.code !== 'EEXIST') throw error;
    }

    if (staleProfileCommandLock(lockPath)) {
      try { unlinkSync(lockPath); } catch {}
      continue;
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `another command is still using Chrome profile '${session}' after ${timeoutMs / 1000}s`
      );
      error.code = 'LANE_BUSY';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, PROFILE_LOCK_POLL_MS));
  }
}
