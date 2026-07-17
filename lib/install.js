import { execSync } from 'child_process';
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { paths, SYSTEM_CHROME, SYSTEM_CHROME_BIN, CLI_CONFIG, PLAYWRIGHT_CLI_VERSION } from './config.js';
import { ensureInjectable } from './sign.js';

function run(cmd, opts = {}) {
  console.log(`==> ${opts.label || cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function isNewer(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  return statSync(a).mtimeMs > statSync(b).mtimeMs;
}

export async function install() {
  const { runtimeDir, playwrightDir, pw, chromeApp, chromeBin, dylib, windowAlpha, config, profilesDir } = paths;

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(playwrightDir, { recursive: true });

  // ── 1. Install playwright-cli locally + apply patches ──
  const browserTypeJs = join(playwrightDir, 'node_modules/playwright-core/lib/server/browserType.js');
  if (!existsSync(browserTypeJs)) {
    run(`cd "${playwrightDir}" && npm init -y --silent && npm install @playwright/cli@${PLAYWRIGHT_CLI_VERSION} --silent`, {
      label: `Installing @playwright/cli@${PLAYWRIGHT_CLI_VERSION} locally...`,
    });
  } else {
    console.log('==> @playwright/cli already installed');
  }

  // Apply patches
  const patchFiles = readdirSync(paths.patchesDir).filter(f => f.endsWith('.patch'));
  for (const name of patchFiles) {
    const patchPath = join(paths.patchesDir, name);
    try {
      execSync(`cd "${playwrightDir}" && patch -p0 --dry-run < "${patchPath}"`, { stdio: 'pipe' });
      run(`cd "${playwrightDir}" && patch -p0 < "${patchPath}"`, { label: `Applying ${name}...` });
    } catch {
      console.log(`==> ${name} already applied or version changed, skipping`);
    }
  }

  // Create launcher symlink
  const pwBin = join(playwrightDir, 'node_modules/.bin/playwright-cli');
  if (existsSync(pwBin)) {
    execSync(`ln -sf "${pwBin}" "${pw}"`);
  }

  // ── 2. APFS clone Chrome + re-sign ──
  if (!existsSync(SYSTEM_CHROME)) {
    console.error(`ERROR: Google Chrome not found at ${SYSTEM_CHROME}`);
    process.exit(1);
  }

  const needsClone = !existsSync(chromeApp) || isNewer(SYSTEM_CHROME_BIN, chromeBin);
  if (needsClone) {
    run(`rm -rf "${chromeApp}" && /bin/cp -Rc "${SYSTEM_CHROME}" "${chromeApp}"`, {
      label: 'Cloning Chrome (APFS copy-on-write)...',
    });
    run(`xattr -cr "${chromeApp}" && codesign --force --sign - "${chromeBin}"`, {
      label: 'Re-signing Chrome binary...',
    });
  } else if (ensureInjectable()) {
    // Clone is current but a background update re-signed its binary; heal it.
    console.log('==> Re-applied ad-hoc signature (clone was re-signed by an update)');
  } else {
    console.log('==> Chrome clone up to date');
  }

  // ── 3. Compile DYLD hook ──
  if (!existsSync(dylib) || isNewer(paths.windowSuppressM, dylib)) {
    run(
      `cc -dynamiclib -framework AppKit -framework Foundation -o "${dylib}" "${paths.windowSuppressM}"`,
      { label: 'Compiling window_suppress.dylib...' }
    );
  } else {
    console.log('==> window_suppress.dylib up to date');
  }

  // ── 4. Compile window_alpha tool ──
  if (!existsSync(windowAlpha) || isNewer(paths.windowAlphaM, windowAlpha)) {
    run(
      `cc -framework CoreGraphics -framework CoreFoundation -o "${windowAlpha}" "${paths.windowAlphaM}"`,
      { label: 'Compiling window_alpha...' }
    );
  } else {
    console.log('==> window_alpha up to date');
  }

  // ── 5. Create config ──
  if (!existsSync(config)) {
    writeFileSync(config, JSON.stringify(CLI_CONFIG));
    console.log('==> Created cli.config.json');
  } else {
    console.log('==> cli.config.json exists');
  }

  // The `browser` skill is NOT installed here — it ships as a Claude Code plugin
  // in this same repo (a plugin marketplace) and is installed the canonical way:
  //   claude plugin marketplace add andylizf/web-plane
  //   claude plugin install browser@web-plane
  // See README. `web-plane install` only sets up the CLI runtime.

  console.log('\nSetup complete. Runtime files:');
  run(`ls -1 "${runtimeDir}"`, { label: runtimeDir });
}
