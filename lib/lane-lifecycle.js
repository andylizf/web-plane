import { evalAllFrames } from './page-diagnostics.js';

const LIFECYCLE_SYMBOL = 'web-plane.lifecycle.v1';

export const LIFECYCLE_TRACKER_SCRIPT = `(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return { installed: false };
  const key = Symbol.for(${JSON.stringify(LIFECYCLE_SYMBOL)});
  if (window[key]) return { installed: true };
  const state = { dirty: false };
  Object.defineProperty(window, key, { value: state, configurable: false });
  const markDirty = event => { if (event.isTrusted) state.dirty = true; };
  document.addEventListener('input', markDirty, true);
  document.addEventListener('change', markDirty, true);
  document.addEventListener('reset', event => {
    setTimeout(() => { if (!event.defaultPrevented) state.dirty = false; }, 0);
  }, true);
  document.addEventListener('submit', event => {
    setTimeout(() => { if (!event.defaultPrevented) state.dirty = false; }, 0);
  }, true);
  return { installed: true };
})()`;

export const LIFECYCLE_PROBE_EXPRESSION = `(() => {
  const state = window[Symbol.for(${JSON.stringify(LIFECYCLE_SYMBOL)})];
  const mediaPlaying = [...document.querySelectorAll('audio,video')].some(media =>
    !media.paused && !media.ended
  );
  const beforeUnloadKnown = typeof getEventListeners === 'function';
  const beforeUnload = beforeUnloadKnown && (
    typeof window.onbeforeunload === 'function' ||
    (getEventListeners(window).beforeunload?.length ?? 0) > 0
  );
  return {
    tracked: Boolean(state),
    dirty: state?.dirty === true,
    mediaPlaying,
    beforeUnloadKnown,
    beforeUnload,
  };
})()`;

export async function installLifecycleTracker(connection, sessionId) {
  await connection.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: LIFECYCLE_TRACKER_SCRIPT },
    sessionId
  );
  await connection.send(
    'Runtime.evaluate',
    { expression: LIFECYCLE_TRACKER_SCRIPT, returnByValue: true },
    sessionId
  );
}

export async function installLifecycleTrackerAcrossFrames(port, targetId) {
  return evalAllFrames(port, targetId, LIFECYCLE_TRACKER_SCRIPT);
}

export async function inspectLaneLifecycle(port, targetId) {
  return evalAllFrames(port, targetId, LIFECYCLE_PROBE_EXPRESSION, {
    includeCommandLineAPI: true,
  });
}

function decision(reason, ageMs = null) {
  return { eligible: reason === 'eligible', reason, ageMs };
}

export function laneReapDecision({
  state,
  nowMs = Date.now(),
  ttlMs,
  hidden,
  targetId,
  frames,
  activeRequests = 0,
  activeDownloads = 0,
}) {
  const lastCommandMs = Date.parse(state?.lastCommandAt ?? '');
  if (!Number.isFinite(lastCommandMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return decision('inspection-unknown');
  }
  const ageMs = Math.max(0, nowMs - lastCommandMs);
  if (ageMs < ttlMs) return decision('not-idle', ageMs);
  if (state?.keep === true) return decision('explicit-keep', ageMs);
  if (hidden === false) return decision('session-visible', ageMs);
  if (hidden !== true) return decision('hidden-state-unknown', ageMs);
  if (!state?.targetId || state.targetId !== targetId) return decision('target-mismatch', ageMs);
  if (activeDownloads > 0) return decision('download-active', ageMs);
  if (activeRequests > 0) return decision('network-active', ageMs);
  if (!Array.isArray(frames) || !frames.length) return decision('inspection-unknown', ageMs);
  if (frames.some((frame) =>
    frame.error ||
    frame.value?.tracked !== true ||
    frame.value?.beforeUnloadKnown !== true
  )) {
    return decision('inspection-unknown', ageMs);
  }
  if (frames.some((frame) => frame.value.beforeUnload === true)) {
    return decision('beforeunload-registered', ageMs);
  }
  if (frames.some((frame) => frame.value.dirty === true)) {
    return decision('unsubmitted-input', ageMs);
  }
  if (frames.some((frame) => frame.value.mediaPlaying === true)) {
    return decision('media-playing', ageMs);
  }
  return decision('eligible', ageMs);
}
