import { execSync } from 'child_process';
import { join } from 'path';
import { paths } from './config.js';
import { openHidden } from './commands.js';

/**
 * List running cloned-Chrome processes (one line each).
 */
function chromeLines() {
  try {
    return execSync(
      'ps aux | grep -i "Google Chrome" | grep -v grep | grep -v Helper',
      { encoding: 'utf8' }
    ).split('\n');
  } catch {
    return [];
  }
}

/**
 * Resolve the CDP tcp port for a session by matching its --user-data-dir
 * exactly (avoids prefix collisions like `agtest` vs `agtest2`).
 */
function portForSession(session) {
  const profileDir = join(paths.profilesDir, session);
  for (const line of chromeLines()) {
    const udd = line.match(/--user-data-dir=(\S+)/);
    const prt = line.match(/--remote-debugging-port=(\d+)/);
    if (udd && prt && udd[1] === profileDir) return parseInt(prt[1], 10);
  }
  return null;
}

function sleep(seconds) {
  try {
    execSync(`sleep ${seconds}`);
  } catch {}
}

/**
 * `web-plane cdp [-s=<name>]`
 *
 * Ensures a hidden session is running and prints the CDP port playwright-cli
 * assigned it, plus a ready-to-paste `agent-browser connect <port>` line. This
 * turns web-plane into a stealth-kernel provider: agent-browser (or any CDP
 * driver) does the operations, web-plane keeps ownership of show/hide/close.
 * The port is auto-assigned (playwright-cli allocates it and ignores any
 * pinned one), so read it from this command's output rather than hardcoding.
 */
export async function cdp(session) {
  session = session || 'default';

  let port = portForSession(session);

  if (!port) {
    const status = openHidden(session);
    if (status !== 0) {
      console.error(`Failed to start hidden session '${session}'.`);
      process.exit(status);
    }
    // Chrome may take a moment to expose the port; poll briefly.
    for (let i = 0; i < 10 && !port; i++) {
      sleep(0.3);
      port = portForSession(session);
    }
  }

  if (!port) {
    console.error(
      `Could not resolve a CDP port for session '${session}'. ` +
        `Is web-plane installed? Try: web-plane install`
    );
    process.exit(1);
  }

  console.log(`Session:  ${session}`);
  console.log(`CDP port: ${port}`);
  console.log(`Attach:   agent-browser connect ${port}`);
  console.log(`Hide/show: web-plane -s=${session} hide | show`);
}
