import { spawnSync } from 'child_process';
import { join } from 'path';
import { PROJECT_DIR } from './config.js';

// npm keeps dependency binaries private to the package that declared them. A
// global web-plane install therefore does not put agent-browser on the user's
// PATH, and consulting PATH here can silently select an older Homebrew copy.
// Invoke the pinned package entry with this process's Node instead.
export const AGENT_BROWSER_ENTRY = join(
  PROJECT_DIR,
  'node_modules',
  'agent-browser',
  'bin',
  'agent-browser.js'
);

/** Run web-plane's packaged agent-browser, never an unrelated PATH entry. */
export function runAgentBrowser(args, options = {}) {
  // The override exists for tests that prove an old or broken dependency is
  // rejected. Production installs always use the package entry above.
  const override = process.env.WEB_PLANE_TEST_AGENT_BROWSER_BIN;
  return override
    ? spawnSync(override, args, options)
    : spawnSync(process.execPath, [AGENT_BROWSER_ENTRY, ...args], options);
}
