function decision(reason, ageMs = null) {
  return { eligible: reason === 'hard-timeout', reason, ageMs };
}

/** Decide whether one lane has crossed its unconditional idle deadline. */
export function laneReapDecision({ state, nowMs = Date.now(), ttlMs, targetId }) {
  const lastCommandMs = Date.parse(state?.lastCommandAt ?? '');
  if (!Number.isFinite(lastCommandMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return decision('inspection-unknown');
  }
  const ageMs = Math.max(0, nowMs - lastCommandMs);
  if (ageMs < ttlMs) return decision('not-idle', ageMs);
  if (!state?.targetId || state.targetId !== targetId) {
    return decision('target-mismatch', ageMs);
  }
  return decision('hard-timeout', ageMs);
}

/** Schedule at the lease deadline while retaining a bounded health-check cadence. */
export function nextLaneSweepDelay({
  state,
  nowMs = Date.now(),
  ttlMs,
  intervalMs,
  minimumMs = 25,
}) {
  const lastCommandMs = Date.parse(state?.lastCommandAt ?? '');
  if (
    !Number.isFinite(lastCommandMs) ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) return intervalMs;
  const remainingMs = ttlMs - Math.max(0, nowMs - lastCommandMs);
  return Math.max(minimumMs, Math.min(intervalMs, remainingMs));
}
