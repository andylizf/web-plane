import { execFileSync, execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, cpSync } from 'fs';
import { join } from 'path';

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
  browserType: 'web-plane: DYLD injection',
  crBrowser: 'web-plane: transition from DYLD',
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
 * @param {boolean} opts.browserTypePatch  leave the DYLD-injection marker in place
 * @param {boolean} opts.crBrowserFile     create the second patched file at all
 * @param {'adhoc'|'signed'|'missing'} opts.clone  how the cloned Chrome is signed
 * @param {boolean} opts.dylib             the compiled suppression hook exists
 * @param {string|null} opts.cloneVersion  null = match system Chrome
 */
export function makeRuntime(home, opts = {}) {
  const {
    browserTypePatch = true,
    crBrowserFile = true,
    clone = 'adhoc',
    dylib = true,
    cloneVersion = null,
  } = opts;

  const runtime = join(home, '.web-plane');
  const pwServer = join(runtime, 'playwright-cli', 'node_modules', 'playwright-core', 'lib', 'server');
  mkdirSync(join(pwServer, 'chromium'), { recursive: true });
  mkdirSync(join(runtime, 'profiles'), { recursive: true });

  writeFileSync(
    join(pwServer, 'browserType.js'),
    browserTypePatch
      ? `// ${MARKERS.browserType}\nmodule.exports = {};\n`
      : `// unpatched upstream file\nmodule.exports = {};\n`
  );
  if (crBrowserFile) {
    writeFileSync(
      join(pwServer, 'chromium', 'crBrowser.js'),
      `// ${MARKERS.crBrowser}\nmodule.exports = {};\n`
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

  if (dylib) writeFileSync(join(runtime, 'window_suppress.dylib'), 'not a real dylib\n');
  else rmSync(join(runtime, 'window_suppress.dylib'), { force: true });

  return runtime;
}
