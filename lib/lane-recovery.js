import { CdpConnection } from './cdp-client.js';

function targetId(target) {
  return target?.id ?? target?.targetId ?? null;
}

export function publicTarget(target, index) {
  let url = String(target?.url ?? '');
  try {
    const parsed = new URL(url);
    url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    url = url.split(/[?#]/, 1)[0];
  }
  return { index, title: target?.title ?? '', url };
}

/** Select a restored tab only when the lane evidence identifies one candidate. */
export function resolveRestoredTarget(saved, targets) {
  if (!saved?.url) return { status: 'missing', reason: 'no-saved-url', candidates: [] };
  const indexed = targets.map((target, tabIndex) => ({ ...target, tabIndex }));
  const urlMatches = indexed.filter((target) => target.url === saved.url);
  if (!urlMatches.length) return { status: 'missing', reason: 'url-not-restored', candidates: [] };

  if (saved.title) {
    const titleMatches = urlMatches.filter((target) => target.title === saved.title);
    if (titleMatches.length === 1) return { status: 'matched', target: titleMatches[0] };
  }

  if (urlMatches.length === 1) return { status: 'matched', target: urlMatches[0] };
  return { status: 'ambiguous', reason: 'multiple-url-matches', candidates: urlMatches };
}

export async function listRestoredPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  return (await response.json())
    .filter((target) => target.type === 'page')
    .map((target) => ({
      id: targetId(target),
      title: target.title ?? '',
      url: target.url ?? '',
    }));
}

/**
 * Memory Saver replaces a discarded tab with a placeholder under a new target
 * id, keeping its URL and title. Resolve it with the same evidence rules as a
 * restored tab, never considering the target that just went away.
 */
export function resolveDiscardReplacement(saved, targets, oldId) {
  return resolveRestoredTarget(saved, targets.filter((target) => targetId(target) !== oldId));
}

/**
 * Ask every page target to evaluate `1` over one browser connection, in
 * parallel. A tab whose renderer is wedged answers nothing, while the browser
 * still lists and can close it; that is the tab that makes agent-browser hang.
 */
export async function probePageTargets(port, { timeoutMs = 2_000, targetIds = null } = {}) {
  const connection = await CdpConnection.connect(port, timeoutMs);
  try {
    const { targetInfos = [] } = await connection.send('Target.getTargets', {}, null, timeoutMs);
    const pages = targetInfos.filter((target) => target.type === 'page' &&
      (!targetIds || targetIds.includes(target.targetId)));
    return await Promise.all(pages.map(async (target) => {
      const entry = { id: target.targetId, url: target.url ?? '', title: target.title ?? '' };
      try {
        const sessionId = await connection.attachTarget(target.targetId);
        await connection.send('Runtime.evaluate', { expression: '1', returnByValue: true }, sessionId, timeoutMs);
        connection.send('Target.detachFromTarget', { sessionId }, null, timeoutMs).catch(() => {});
        return { ...entry, responsive: true };
      } catch (error) {
        return { ...entry, responsive: false, error: error.message };
      }
    }));
  } finally {
    connection.close();
  }
}

/** Describe unresponsive tabs by the lane that owns each, so only that lane's agent closes it. */
export function describeUnresponsiveTargets(probes, laneStates, currentLane) {
  const owners = new Map(laneStates.filter((state) => state.targetId).map((state) => [state.targetId, state.lane]));
  return probes.filter((probe) => !probe.responsive).map((probe) => {
    const owner = owners.get(probe.id) ?? null;
    const where = publicTarget(probe, 0).url || '(no url)';
    const action = owner === currentLane
      ? 'this lane\'s own tab'
      : owner ? `lane '${owner}'; its agent can close it with: web-plane lane ${owner} close`
        : 'not a web-plane lane; close it in Chrome';
    return { ...probe, owner, line: `${probe.id} ${where} (${action})` };
  });
}
