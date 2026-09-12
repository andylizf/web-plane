import { execFileSync, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import { PATCH_MARKERS, RUNTIME_VERSION } from '../../lib/config.js';

/**
 * A fake `~/.web-plane` with every layer of the stealth kernel present — and a
 * switch to break exactly one of them.
 *
 * `doctor` exists to catch a degraded install, so the only way to know it works
 * is to hand it installs that are degraded in each specific way and check it
 * says which. A `doctor` that always exits 1 would satisfy every "detects the
 * breakage" test on its own, which is why the healthy case is tested too.
 */

const MARKERS = {
  browserType: PATCH_MARKERS.find(({ file }) => file.endsWith('/browserType.js'))?.marker,
  crBrowser: PATCH_MARKERS.find(({ file }) => file.endsWith('/crBrowser.js'))?.marker,
  chromium: PATCH_MARKERS.find(({ file }) => file.endsWith('/chromium.js'))?.marker,
  crPage: PATCH_MARKERS.find(({ file }) => file.endsWith('/crPage.js'))?.marker,
};

export const SYSTEM_CHROME_APP = '/Applications/Google Chrome.app';

export function systemChromeVersion() {
  try {
    return execSync(
      `defaults read "${join(SYSTEM_CHROME_APP, 'Contents', 'Info.plist')}" CFBundleShortVersionString`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} home             fake $HOME
 * @param {object} opts
 * @param {boolean|'legacy'} opts.browserTypePatch  which DYLD-injection marker to write
 * @param {boolean} opts.crBrowserFile     create the second patched file at all
 * @param {boolean} opts.chromiumFile      create the native-session restore patch marker
 * @param {boolean} opts.crPageFile        create the focus-emulation patch marker
 * @param {'adhoc'|'signed'|'missing'} opts.clone  how the cloned Chrome is signed
 * @param {boolean|'legacy'} opts.dylib    which suppression hook exists
 * @param {string|null} opts.cloneVersion  null = match system Chrome
 * @param {string|null} opts.runtimeVersion null = omit the version file
 * @param {boolean} opts.profileSplit create a legacy Default + Profile 1 user-data-dir
 */
export function makeRuntime(home, opts = {}) {
  const {
    browserTypePatch = true,
    crBrowserFile = true,
    chromiumFile = true,
    crPageFile = true,
    clone = 'adhoc',
    dylib = true,
    cloneVersion = null,
    runtimeVersion = RUNTIME_VERSION,
    profileSplit = false,
  } = opts;

  const runtime = join(home, '.web-plane');
  const pwServer = join(runtime, 'playwright-cli', 'node_modules', 'playwright-core', 'lib', 'server');
  mkdirSync(join(pwServer, 'chromium'), { recursive: true });
  mkdirSync(join(runtime, 'profiles'), { recursive: true });
  if (profileSplit) {
    const profile = join(runtime, 'profiles', 'legacy-split');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    mkdirSync(join(profile, 'Profile 1'), { recursive: true });
    writeFileSync(join(profile, 'Local State'), JSON.stringify({
      profile: {
        last_used: 'Default',
        last_active_profiles: [],
        picker_shown: true,
        info_cache: {
          Default: { name: 'Default' },
          'Profile 1': { name: 'Workspace' },
        },
      },
    }));
  }

  writeFileSync(
    join(pwServer, 'browserType.js'),
    browserTypePatch === 'legacy'
      ? '// web-plane: DYLD injection\nmodule.exports = {};\n'
      : browserTypePatch
        ? `// ${MARKERS.browserType}\nmodule.exports = {};\n`
        : `// unpatched upstream file\nmodule.exports = {};\n`
  );
  if (crBrowserFile) {
    writeFileSync(
      join(pwServer, 'chromium', 'crBrowser.js'),
      `// ${MARKERS.crBrowser}\nmodule.exports = {};\n`
    );
  }
  if (chromiumFile) {
    writeFileSync(
      join(pwServer, 'chromium', 'chromium.js'),
      `// ${MARKERS.chromium}\nmodule.exports = {};\n`
    );
  }
  if (crPageFile) {
    writeFileSync(
      join(pwServer, 'chromium', 'crPage.js'),
      `// ${MARKERS.crPage}\nmodule.exports = {};\n`
    );
  }

  const macos = join(runtime, 'Chrome.app', 'Contents', 'MacOS');
  if (clone !== 'missing') {
    mkdirSync(macos, { recursive: true });
    const bin = join(macos, 'Google Chrome');
    if (clone === 'adhoc') {
      // A binary the linker ad-hoc signs — the state DYLD_INSERT_LIBRARIES needs.
      const src = join(runtime, 'stub.c');
      writeFileSync(src, 'int main(void) { return 0; }\n');
      execFileSync('cc', ['-o', bin, src], { stdio: 'ignore' });
      execSync(`codesign --force --sign - "${bin}"`, { stdio: 'ignore' });
    } else {
      // A real certificate-signed binary: what Chrome's own updater leaves
      // behind when it re-signs the clone, and the state in which the injection
      // is silently ignored and every window flashes on screen.
      cpSync('/bin/echo', bin);
    }
    const plist = join(runtime, 'Chrome.app', 'Contents', 'Info.plist');
    const version = cloneVersion ?? systemChromeVersion();
    if (version) {
      writeFileSync(
        plist,
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
          `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`
      );
    }
  }

  if (dylib === 'legacy') writeFileSync(join(runtime, 'window_suppress.dylib'), 'pid protocol\n');
  else if (dylib === 'panel-only') {
    writeFileSync(join(runtime, 'window_suppress.dylib'), 'WEB_PLANE_RUN_ID\0.panel-request-\0');
  }
  else if (dylib) {
    writeFileSync(
      join(runtime, 'window_suppress.dylib'),
      'WEB_PLANE_RUN_ID\0.panel-request-\0ui-status\0'
    );
  }
  else rmSync(join(runtime, 'window_suppress.dylib'), { force: true });
  if (runtimeVersion !== null) writeFileSync(join(runtime, 'runtime-version'), `${runtimeVersion}\n`);

  return runtime;
}
