import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';

const STATE_VERSION = 1;
const SAFE_LEGACY_NAME = /^[A-Za-z0-9._-]+$/;

function laneKey(lane) {
  return createHash('sha256').update(lane).digest('hex');
}

export function laneStatePaths(lane) {
  const dir = join(paths.runtimeDir, 'lanes');
  return {
    dir,
    state: join(dir, `${laneKey(lane)}.json`),
    legacy: SAFE_LEGACY_NAME.test(lane) ? join(dir, `${lane}.json`) : null,
  };
}

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof state?.session !== 'string' || !Number.isInteger(state?.port)) return null;
    return state;
  } catch {
    return null;
  }
}

function writeState(lane, state) {
  const statePaths = laneStatePaths(lane);
  mkdirSync(statePaths.dir, { recursive: true, mode: 0o700 });
  chmodSync(statePaths.dir, 0o700);
  const staged = `${statePaths.state}.staged-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(staged, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(staged, statePaths.state);
    chmodSync(statePaths.state, 0o600);
  } catch (error) {
    try { unlinkSync(staged); } catch {}
    throw error;
  }
  return state;
}

export function recallLane(lane) {
  const statePaths = laneStatePaths(lane);
  const current = readState(statePaths.state);
  if (current) return current;
  if (!statePaths.legacy || !existsSync(statePaths.legacy)) return null;

  const legacy = readState(statePaths.legacy);
  if (!legacy) return null;
  const migrated = writeState(lane, {
    ...legacy,
    version: STATE_VERSION,
    lane,
    updatedAt: legacy.updatedAt ?? new Date().toISOString(),
  });
  // The verified hashed record is now the durable copy. Leaving the unhashed
  // file beside it would create two sources of truth for later readers.
  if (readState(statePaths.state)) unlinkSync(statePaths.legacy);
  return migrated;
}

export function rememberLane(lane, session, port, target = {}) {
  const previous = recallLane(lane) ?? {};
  const definedTarget = Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined)
  );
  return writeState(lane, {
    ...previous,
    ...definedTarget,
    version: STATE_VERSION,
    lane,
    session,
    port,
    updatedAt: new Date().toISOString(),
  });
}

export function updateLaneTarget(lane, target) {
  const previous = recallLane(lane);
  if (!previous) return null;
  return rememberLane(lane, previous.session, previous.port, target);
}

export function forgetLane(lane) {
  const statePaths = laneStatePaths(lane);
  for (const path of [statePaths.state, statePaths.legacy].filter(Boolean)) {
    try { unlinkSync(path); } catch {}
  }
}
