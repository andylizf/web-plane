import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const runtimeOverride = process.env.WEB_PLANE_RUNTIME_DIR;

function positiveDuration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export const RUNTIME_DIR = runtimeOverride
  ? resolve(runtimeOverride)
  : join(homedir(), '.web-plane');
export const RUN_DIR = runtimeOverride
  ? join(RUNTIME_DIR, 'run')
  : join(homedir(), 'Library', 'Application Support', 'web-plane', 'run');
export const PROJECT_DIR = join(__dirname, '..');

export const paths = {
  // Runtime (per-user, created by `web-plane install`)
  runtimeDir: RUNTIME_DIR,
  runDir: RUN_DIR,
  playwrightDir: join(RUNTIME_DIR, 'playwright-cli'),
  pw: join(RUNTIME_DIR, 'pw'),
  chromeApp: join(RUNTIME_DIR, 'Chrome.app'),
  chromeBin: join(RUNTIME_DIR, 'Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  dylib: join(RUNTIME_DIR, 'window_suppress.dylib'),
  windowAlpha: join(RUNTIME_DIR, 'window_alpha'),
  runtimeVersion: join(RUNTIME_DIR, 'runtime-version'),
  runtimeBackupsDir: join(RUNTIME_DIR, 'backups'),
  runtimeStagingDir: join(RUNTIME_DIR, 'staging'),
  installLogsDir: join(RUNTIME_DIR, 'logs'),
  config: join(RUNTIME_DIR, 'cli.config.json'),
  profilesDir: join(RUNTIME_DIR, 'profiles'),

  // Source (in the package)
  nativeDir: join(PROJECT_DIR, 'native'),
  patchesDir: join(PROJECT_DIR, 'patches'),
  windowSuppressM: join(PROJECT_DIR, 'native', 'window_suppress.m'),
  panelControlM: join(PROJECT_DIR, 'native', 'panel_control.m'),
  windowAlphaM: join(PROJECT_DIR, 'native', 'window_alpha.m'),
  playwrightPackageDir: join(PROJECT_DIR, 'runtime', 'playwright'),
};

export const SYSTEM_CHROME = '/Applications/Google Chrome.app';
export const SYSTEM_CHROME_BIN = join(SYSTEM_CHROME, 'Contents', 'MacOS', 'Google Chrome');

export const CLI_CONFIG = {
  browser: {
    browserName: 'chromium',
    launchOptions: {
      channel: 'chrome',
      headless: false,
      args: [
        '--start-minimized',
        '--disable-session-crashed-bubble',
        '--enable-logging',
        '--restore-last-session',
        '--profile-directory=Default',
      ],
    },
    isolated: false,
  },
};

// Pinned versions — patches are validated against these
export const PLAYWRIGHT_CLI_VERSION = '0.1.1';
export const PLAYWRIGHT_CORE_VERSION = '1.59.0-alpha-1771104257000';
// Bump only when the JS launcher, Playwright patches and dylib stop speaking the
// same state protocol. `install` writes it after rebuilding all three together.
export const RUNTIME_VERSION = '9';

// Every patch must leave a marker in the file it edits. `install` asserts these
// after patching and `doctor` checks them — without that assertion a patch can
// silently fail to apply (or get reversed) and web-plane degrades all the way
// down to launching the *system* Chrome with no DYLD hook, no window
// suppression, and no stealth, while still reporting success.
export const PATCH_MARKERS = [
  {
    file: 'node_modules/playwright-core/lib/server/browserType.js',
    marker: 'WEB_PLANE_RUN_ID',
    what: 'launch the cloned Chrome with the window-suppression dylib',
  },
  {
    file: 'node_modules/playwright-core/lib/server/chromium/crBrowser.js',
    marker: 'WEB_PLANE_RUN_DIR',
    what: 'hand the hidden window from the launch hook to CDP',
  },
  {
    file: 'node_modules/playwright-core/lib/server/chromium/chromium.js',
    marker: 'WEB_PLANE_NATIVE_SESSION_RESTORE',
    what: 'let Chrome restore its saved tabs without adding a synthetic blank page',
  },
];

// This is the first release with persistent CDP target binding and strict
// --pin-tab semantics. web-plane relies on that binding instead of switching
// tabs before every command, which used to invalidate snapshot refs.
export const MIN_AGENT_BROWSER = '0.34.0';
export const PLAYWRIGHT_LAUNCH_TIMEOUT_MS = 45_000;
export const AGENT_BROWSER_ATTACH_TIMEOUT_MS = 20_000;
export const LANE_TTL_MS = positiveDuration(
  'WEB_PLANE_LANE_TTL_MS',
  24 * 60 * 60 * 1000
);
export const REAP_INTERVAL_MS = positiveDuration(
  'WEB_PLANE_REAP_INTERVAL_MS',
  60 * 60 * 1000
);
