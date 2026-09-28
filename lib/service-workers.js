import { CdpConnection } from './cdp-client.js';

// How long Chrome takes to report the registrations after ServiceWorker.enable.
const REPORT_SETTLE_MS = 500;

/**
 * Stop every running, activated service worker that controls no page.
 *
 * Chrome stops an idle worker about 30 s after its last event, but never while
 * DevTools is attached, and each lane's agent-browser daemon auto-attaches to
 * every worker in the browser. A site's worker therefore outlived the lane that
 * opened it and kept its renderer resident: one site held 7 GB for a day
 * after its tab closed. Chrome honours an explicit stop despite the attachment,
 * and the next page on that origin starts the worker again.
 *
 * Returns the script URLs it stopped.
 */
export async function stopClientlessServiceWorkers(port) {
  const connection = await CdpConnection.connect(port);
  try {
    const { targetInfos = [] } = await connection.send('Target.getTargets', {}, null, 2_000);
    // The ServiceWorker domain lives on page targets and reports the whole profile.
    const page = targetInfos.find((target) => target.type === 'page');
    if (!page) return [];
    const sessionId = await connection.attachTarget(page.targetId);
    const versions = new Map();
    connection.onEvent((message) => {
      if (message.sessionId !== sessionId || message.method !== 'ServiceWorker.workerVersionUpdated') return;
      for (const version of message.params?.versions ?? []) versions.set(version.versionId, version);
    });
    await connection.send('ServiceWorker.enable', {}, sessionId, 2_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, REPORT_SETTLE_MS));
    const idle = [...versions.values()].filter((version) =>
      version.runningStatus === 'running' &&
      version.status === 'activated' &&
      !version.controlledClients?.length
    );
    for (const version of idle) {
      await connection.send('ServiceWorker.stopWorker', { versionId: version.versionId }, sessionId, 2_000);
    }
    return idle.map((version) => version.scriptURL);
  } finally {
    connection.close();
  }
}
