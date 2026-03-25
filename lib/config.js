import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const RUNTIME_DIR = join(homedir(), '.web-plane');
export const PROJECT_DIR = join(__dirname, '..');

export const paths = {
  // Runtime (per-user, created by `web-plane install`)
  runtimeDir: RUNTIME_DIR,
  playwrightDir: join(RUNTIME_DIR, 'playwright-cli'),
  pw: join(RUNTIME_DIR, 'pw'),
  chromeApp: join(RUNTIME_DIR, 'Chrome.app'),
  chromeBin: join(RUNTIME_DIR, 'Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  dylib: join(RUNTIME_DIR, 'window_suppress.dylib'),
  windowAlpha: join(RUNTIME_DIR, 'window_alpha'),
  config: join(RUNTIME_DIR, 'cli.config.json'),
  profilesDir: join(RUNTIME_DIR, 'profiles'),

  // Source (in the package)
  nativeDir: join(PROJECT_DIR, 'native'),
  patchesDir: join(PROJECT_DIR, 'patches'),
  windowSuppressM: join(PROJECT_DIR, 'native', 'window_suppress.m'),
  windowAlphaM: join(PROJECT_DIR, 'native', 'window_alpha.m'),
};

export const SYSTEM_CHROME = '/Applications/Google Chrome.app';
export const SYSTEM_CHROME_BIN = join(SYSTEM_CHROME, 'Contents', 'MacOS', 'Google Chrome');

export const CLI_CONFIG = {
  browser: {
    browserName: 'chromium',
    launchOptions: {
      channel: 'chrome',
      headless: false,
      args: ['--start-minimized'],
    },
    isolated: false,
  },
};

export const STATE_FILE = '/tmp/.chrome-alpha-hidden';

// Pinned versions — patches are validated against these
export const PLAYWRIGHT_CLI_VERSION = '0.1.1';
export const PLAYWRIGHT_CORE_VERSION = '1.59.0-alpha-1771104257000';
