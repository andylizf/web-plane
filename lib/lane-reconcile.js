import { stopAgentBrowserDaemon } from './agent-browser.js';
import { laneMonitorAlive, startLaneMonitor } from './lane-monitor.js';
import { listRestoredPageTargets, resolveRestoredTarget } from './lane-recovery.js';
import { forgetLane, listLaneStates, updateLaneTarget } from './lane-state.js';
import { appendSessionEvent } from './profile-runtime.js';

const LAUNCH_PAGES = new Set(['about:blank', 'chrome://newtab/']);

/**
 * Decide what a launch or reuse owes the lanes recorded for one session.
 *
 * A lane monitor dies with the browser, and Chrome's native session restore
 * brings the lane's tab back without it, so nothing would ever reap that tab.
 * Pure: takes the session's lane records, the live page targets, a monitor
 * liveness probe, and whether this browser was just launched.
 */
export function planLaneReconciliation({ states, targets, monitorAlive, fresh }) {
  const actions = [];
  const claimed = new Set();
  for (const state of states) {
    if (monitorAlive(state.lane)) {
      if (state.targetId) claimed.add(state.targetId);
      continue;
    }
    if (state.targetId && targets.some((target) => target.id === state.targetId)) {
      claimed.add(state.targetId);
      actions.push({ action: 'rearm', lane: state.lane, targetId: state.targetId, reason: 'target-present' });
      continue;
    }
    const resolution = resolveRestoredTarget(
      state,
      targets.filter((target) => !claimed.has(target.id))
    );
    if (resolution.status === 'matched') {
      const { target } = resolution;
      claimed.add(target.id);
      actions.push({
        action: 'rearm',
        lane: state.lane,
        targetId: target.id,
        url: target.url,
        title: target.title,
        tabIndex: target.tabIndex,
        reason: 'restored-target',
      });
      continue;
    }
    if (resolution.status === 'ambiguous') {
      // Same refusal as lane recovery: never guess between look-alike tabs.
      for (const candidate of resolution.candidates) claimed.add(candidate.id);
      actions.push({
        action: 'unresolved',
        lane: state.lane,
        reason: resolution.reason,
        candidateCount: resolution.candidates.length,
      });
      continue;
    }
    actions.push({ action: 'forget', lane: state.lane, reason: resolution.reason });
  }

  if (fresh) {
    // Restored tabs no lane records cannot be rebound by anything, so on a
    // launch they are litter. A reused browser may hold a tab a person just
    // opened during `show`; leave those alone.
    const orphans = targets.filter(
      (target) => !claimed.has(target.id) && !LAUNCH_PAGES.has(target.url)
    );
    // Closing Chrome's last page exits Chrome; keep one for attach to replace.
    const spare = orphans.length === targets.length ? orphans.slice(1) : orphans;
    for (const target of spare) {
      actions.push({ action: 'close-orphan', targetId: target.id, url: target.url });
    }
  }
  return actions;
}

function summarize(actions) {
  const count = (name) => actions.filter((action) => action.action === name).length;
  const parts = [];
  if (count('rearm')) parts.push(`re-armed ${count('rearm')} idle lane monitor(s)`);
  if (count('forget')) parts.push(`forgot ${count('forget')} lane(s) whose tab is gone`);
  if (count('close-orphan')) parts.push(`closed ${count('close-orphan')} restored tab(s) no lane owns`);
  if (count('unresolved')) parts.push(`left ${count('unresolved')} lane(s) with look-alike tabs unbound`);
  return parts.join(', ');
}

/**
 * Apply the plan: re-arm monitors, forget dead lanes, close unowned restored
 * tabs. Every step lands in the session event log; a failed step is logged and
 * skipped rather than failing the launch that triggered it.
 */
export async function reconcileSessionLanes(session, port, { fresh, closeTarget }) {
  let targets;
  try {
    targets = await listRestoredPageTargets(port);
  } catch (error) {
    appendSessionEvent(session, {
      type: 'lane-reconcile-skipped',
      reason: 'targets-unavailable',
      message: error.message,
    });
    return [];
  }
  const actions = planLaneReconciliation({
    states: listLaneStates(session),
    targets,
    monitorAlive: laneMonitorAlive,
    fresh,
  });
  for (const action of actions) {
    try {
      if (action.action === 'rearm') {
        if (action.reason === 'restored-target') {
          // The record keeps its old port on purpose: the next lane command
          // must still take the recovery path that reconnects its driver.
          updateLaneTarget(action.lane, {
            targetId: action.targetId,
            url: action.url,
            title: action.title,
            tabIndex: action.tabIndex,
          });
        }
        await startLaneMonitor({ lane: action.lane, session, port, targetId: action.targetId });
      } else if (action.action === 'forget') {
        const daemon = await stopAgentBrowserDaemon(action.lane);
        forgetLane(action.lane);
        Object.assign(action, { daemonStopped: daemon.stopped, daemonReason: daemon.reason });
      } else if (action.action === 'close-orphan') {
        await closeTarget(port, action.targetId);
      }
      appendSessionEvent(session, { type: `lane-reconcile-${action.action}`, ...action });
    } catch (error) {
      appendSessionEvent(session, { type: 'lane-reconcile-failed', ...action, message: error.message });
    }
  }
  const summary = summarize(actions);
  if (summary) console.error(`web-plane: ${summary} in session '${session}'.`);
  return actions;
}
