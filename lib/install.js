import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  paths,
  PROJECT_DIR,
  SYSTEM_CHROME,
  CLI_CONFIG,
  PLAYWRIGHT_CLI_VERSION,
  RUNTIME_VERSION,
} from './config.js';
import { ensureInjectable } from './sign.js';
import { patchState, agentBrowserState, cloneRefresh, chromeProcs } from './health.js';

let installLog = null;

function timestamp() {
  return new Date().toISOString();
}

function fileTimestamp() {
  return timestamp().replace(/[:.]/g, '-');
}

function note(message = '') {
  console.log(message);
  if (installLog) appendFileSync(installLog, `[${timestamp()}] ${message}\n`);
}

function fail(message) {
  console.error(message);
  if (installLog) appendFileSync(installLog, `[${timestamp()}] ${message}\n`);
  process.exitCode = 1;
}

function run(command, args, { cwd, label } = {}) {
  note(`==> ${label || [command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, output] of [[process.stdout, result.stdout], [process.stderr, result.stderr]]) {
    if (!output) continue;
    stream.write(output);
    if (installLog) appendFileSync(installLog, output);
  }
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? 'without a status'}`);
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function buildRuntime(stageRoot) {
  const playwrightDir = join(stageRoot, 'playwright-cli');
  mkdirSync(playwrightDir, { recursive: true });
  cpSync(join(paths.playwrightPackageDir, 'package.json'), join(playwrightDir, 'package.json'));
  cpSync(join(paths.playwrightPackageDir, 'package-lock.json'), join(playwrightDir, 'package-lock.json'));
  run('npm', ['ci', '--ignore-scripts', '--silent'], {
    cwd: playwrightDir,
    label: `Installing locked @playwright/cli@${PLAYWRIGHT_CLI_VERSION}...`,
  });

  for (const name of readdirSync(paths.patchesDir).filter((file) => file.endsWith('.patch')).sort()) {
    run('/usr/bin/patch', ['-p0', '--forward', '-i', join(paths.patchesDir, name)], {
      cwd: playwrightDir,
      label: `Applying ${name} to pristine Playwright...`,
    });
  }
  const patch = patchState(playwrightDir);
  if (!patch.ok) {
    throw new Error(
      `patch verification failed: ${patch.missing.map((item) => `${item.file}: ${item.reason}`).join(', ')}`
    );
  }

  run('cc', [
    '-dynamiclib', '-framework', 'AppKit', '-framework', 'Foundation',
    '-o', join(stageRoot, 'window_suppress.dylib'), paths.windowSuppressM, paths.panelControlM,
  ], { label: 'Compiling window_suppress.dylib...' });
  run('cc', [
    '-framework', 'CoreGraphics', '-framework', 'CoreFoundation',
    '-o', join(stageRoot, 'window_alpha'), paths.windowAlphaM,
  ], { label: 'Compiling window_alpha...' });
  writeFileSync(join(stageRoot, 'runtime-version'), `${RUNTIME_VERSION}\n`);
}

function stageChrome(stageRoot, refresh) {
  const chromeApp = join(stageRoot, 'Chrome.app');
  const chromeBin = join(chromeApp, 'Contents', 'MacOS', 'Google Chrome');
  run('/bin/cp', ['-Rc', SYSTEM_CHROME, chromeApp], {
    label: `Cloning Chrome (APFS copy-on-write): ${refresh.why}...`,
  });
  run('xattr', ['-cr', chromeApp], { label: 'Clearing Chrome quarantine metadata...' });
  run('codesign', ['--force', '--sign', '-', chromeBin], { label: 'Ad-hoc signing Chrome...' });
}

function activateStagedRuntime(stageRoot, { replaceChrome }) {
  const backupDir = join(paths.runtimeBackupsDir, `runtime-${fileTimestamp()}`);
  const names = ['playwright-cli', 'window_suppress.dylib', 'window_alpha', 'runtime-version', 'pw'];
  if (replaceChrome) names.push('Chrome.app');
  const backedUp = [];

  for (const name of names) {
    const current = join(paths.runtimeDir, name);
    if (!pathExists(current)) continue;
    if (!backedUp.length) mkdirSync(backupDir, { recursive: true });
    renameSync(current, join(backupDir, name));
    backedUp.push(name);
  }

  try {
    for (const name of names.filter((name) => name !== 'pw')) {
      renameSync(join(stageRoot, name), join(paths.runtimeDir, name));
    }
    symlinkSync(join(paths.playwrightDir, 'node_modules/.bin/playwright-cli'), paths.pw);
  } catch (error) {
    for (const name of names) {
      const current = join(paths.runtimeDir, name);
      if (pathExists(current)) renameSync(current, join(stageRoot, name));
    }
    for (const name of backedUp) {
      const current = join(paths.runtimeDir, name);
      renameSync(join(backupDir, name), current);
    }
    throw error;
  }

  rmSync(stageRoot, { recursive: true, force: true });
  if (backedUp.length) note(`==> Previous generated runtime backed up to ${backupDir}`);
}

export async function install() {
  const checkout = existsSync(join(PROJECT_DIR, '.git'));
  if (checkout && !process.env.WEB_PLANE_RUNTIME_DIR) {
    fail(
      'ERROR: refusing to install the production runtime from a mutable git checkout.\n' +
        'Install the CLI package first:\n' +
        '  npm install -g github:andylizf/web-plane\n' +
        'For development, set WEB_PLANE_RUNTIME_DIR to a project-local tmp/ path.'
    );
    return;
  }

  mkdirSync(paths.runtimeDir, { recursive: true });
  mkdirSync(paths.profilesDir, { recursive: true });
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.runDir, 0o700);
  mkdirSync(paths.runtimeStagingDir, { recursive: true });
  mkdirSync(paths.runtimeBackupsDir, { recursive: true });
  mkdirSync(paths.installLogsDir, { recursive: true });
  installLog = join(paths.installLogsDir, `install-${fileTimestamp()}.log`);
  writeFileSync(installLog, `[${timestamp()}] web-plane install\n`);
  note(`Install log: ${installLog}`);

  if (!existsSync(SYSTEM_CHROME)) {
    fail(`ERROR: Google Chrome not found at ${SYSTEM_CHROME}`);
    return;
  }
  const live = chromeProcs().filter((proc) => proc.managed);
  if (live.length) {
    fail(
      'ERROR: close all web-plane sessions before rebuilding the runtime.\n' +
        live.map((proc) => `  web-plane -s=${proc.session ?? '<name>'} close`).join('\n') +
        `\nNo runtime files were changed. Log: ${installLog}`
    );
    return;
  }

  const refresh = cloneRefresh();
  const stageRoot = join(paths.runtimeStagingDir, `install-${fileTimestamp()}-${randomUUID()}`);
  mkdirSync(stageRoot, { recursive: true });
  buildRuntime(stageRoot);
  if (refresh.needed) stageChrome(stageRoot, refresh);
  activateStagedRuntime(stageRoot, { replaceChrome: refresh.needed });

  if (!refresh.needed) {
    if (ensureInjectable()) note('==> Re-applied ad-hoc signature after a Chrome update');
    else note(`==> Chrome clone up to date: ${refresh.why}`);
  }
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, JSON.stringify(CLI_CONFIG));
    note('==> Created cli.config.json');
  } else {
    note('==> cli.config.json exists');
  }

  const ab = agentBrowserState();
  if (!ab.ok) {
    fail('\nERROR: packaged agent-browser is missing or broken. Reinstall web-plane.');
    return;
  }
  note(`\nSetup complete. Runtime protocol: ${RUNTIME_VERSION}`);
  note(`Verify now with: web-plane doctor\nInstall log: ${installLog}`);
}
