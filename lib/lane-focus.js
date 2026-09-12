import { CdpConnection } from './cdp-client.js';

/**
 * Hold focus emulation on a lane's tab for the duration of one command.
 *
 * Playwright no longer enables it at page creation (see the crPage patch), and
 * the lane monitor's hold lapses after LANE_FOCUS_IDLE_MS. A command against a
 * tab that has gone hidden would otherwise run with document.hasFocus() false
 * and timers throttled, so the CLI holds its own handle while the command runs.
 * The handle belongs to this CDP session and dies with it, so a crashed command
 * cannot leave the tab captured.
 */
export async function holdLaneFocus(port, targetId) {
  if (!targetId) return { held: false, release() {} };
  let connection;
  try {
    connection = await CdpConnection.connect(port, 2_000);
    const sessionId = await connection.attachTarget(targetId);
    await connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId, 2_000);
  } catch (error) {
    connection?.close();
    return { held: false, reason: error.message, release() {} };
  }
  return { held: true, release() { connection.close(); } };
}
