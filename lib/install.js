import { execSync } from 'child_process';
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { paths, SYSTEM_CHROME, SYSTEM_CHROME_BIN, CLI_CONFIG, PLAYWRIGHT_CLI_VERSION } from './config.js';
import { ensureInjectable } from './sign.js';
import { patchState, agentBrowserState } from './health.js';
import { MIN_AGENT_BROWSER } from './config.js';

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

  // Apply patches.
  //
  // `--forward` is not optional. Without it, `patch` asks "Reversed (or
  // previously applied) patch detected! Assume -R? [y]" and — because stdin is
  // redirected from the patch file rather than a tty — auto-answers yes and
  // *un-applies* the patch, exiting 0 the whole time. That made `web-plane
  // install` anti-idempotent: the first run enabled stealth, the second silently
  // tore it out, and the docs told you to re-run after every Chrome update.
  const patchFiles = readdirSync(paths.patchesDir).filter(f => f.endsWith('.patch'));
  for (const name of patchFiles) {
    const patchPath = join(paths.patchesDir, name);
    try {
      execSync(`cd "${playwrightDir}" && patch -p0 --forward < "${patchPath}"`, { stdio: 'pipe' });
      console.log(`==> Applied ${name}`);
    } catch {
      // --forward exits non-zero when the hunks are already in place, which is
      // the common case on a re-run. The marker assertion below is what decides
      // whether that was benign.
      console.log(`==> ${name} already applied`);
    }
  }

  // Assert the patches actually landed. Everything downstream — the cloned
  // Chrome, the DYLD hook, the hidden window — is dead code if they didn't, and
  // the failure is otherwise invisible until someone notices windows popping up.
  const patch = patchState();
  if (!patch.ok) {
    console.error('\nERROR: patch verification failed. Stealth would be silently disabled.');
    for (const m of patch.missing) {
      console.error(`  ${m.file}: ${m.reason} (needed to ${m.what})`);
    }
    console.error(
      `\n@playwright/cli is pinned to ${PLAYWRIGHT_CLI_VERSION}; if that pin moved, the\n` +
        `patches in ${paths.patchesDir} need to be regenerated against the new source.`
    );
    process.exit(1);
  }
  console.log('==> Patch verification OK (browserType + crBrowser)');

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

  // The operation layer is a separate tool, but its version decides whether two
  // concurrent agents can hold different tabs of one browser — worth saying here
  // rather than letting it surface as mysterious cross-talk.
  const ab = agentBrowserState();
  if (ab.installed && !ab.ok) {
    console.log(
      `\n==> NOTE: agent-browser ${ab.version} is below ${MIN_AGENT_BROWSER}. Concurrent\n` +
        `    sessions on one browser will steal each other's active tab.\n` +
        `    Fix: npm i -g agent-browser@latest`
    );
  }

  console.log('\nSetup complete. Runtime files:');
  run(`ls -1 "${runtimeDir}"`, { label: runtimeDir });
  console.log('\nVerify anytime with: web-plane doctor');
}
