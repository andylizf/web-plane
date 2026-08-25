#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { CdpConnection } from '../lib/cdp-client.js';

const cwd = process.cwd();
const args = process.argv.slice(2);

function valueArg(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

const outputDir = resolve(valueArg('--output', 'logs/native-session-restore-20260825/smoke'));
if (outputDir !== cwd && !outputDir.startsWith(`${cwd}/`)) {
  throw new Error(`--output must stay under the project directory: ${outputDir}`);
}
const chromePath = resolve(valueArg(
  '--chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
));
if (!existsSync(chromePath)) throw new Error(`Chrome does not exist at ${chromePath}`);

mkdirSync(outputDir, { recursive: true, mode: 0o700 });
chmodSync(outputDir, 0o700);
const eventsPath = join(outputDir, 'events.jsonl');
const profilesDir = join(outputDir, 'profiles');
mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
chmodSync(profilesDir, 0o700);

function record(event) {
  const row = { timestamp: new Date().toISOString(), ...event };
  appendFileSync(eventsPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(eventsPath, 0o600);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  return row;
}

function writeJsonAtomic(path, value) {
  const staged = `${path}.staged`;
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(staged, path);
  chmodSync(path, 0o600);
}

function sanitizedUrl(input) {
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(input).split(/[?#]/, 1)[0];
  }
}

function normalizePreferences(profileDir, { restore = true, clean = true } = {}) {
  const defaultDir = join(profileDir, 'Default');
  mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
  const path = join(defaultDir, 'Preferences');
  let state = {};
  try { state = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  if (restore) state.session = { ...(state.session ?? {}), restore_on_startup: 1 };
  if (clean) state.profile = { ...(state.profile ?? {}), exit_type: 'Normal', exited_cleanly: true };
  writeJsonAtomic(path, state);
  return path;
}

function copyPreferences(profileDir, label) {
  const source = join(profileDir, 'Default', 'Preferences');
  if (!existsSync(source)) return null;
  const destination = join(outputDir, `${label}.Preferences.json`);
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  return destination;
}

function removeSingletonFiles(profileDir) {
  for (const name of ['DevToolsActivePort', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    try { unlinkSync(join(profileDir, name)); } catch {}
  }
}

async function waitForPort(profileDir, child, timeoutMs = 15_000) {
  const activePort = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before CDP was ready (${child.exitCode})`);
    try {
      const port = Number(readFileSync(activePort, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return port;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Chrome did not publish a live CDP port within ${timeoutMs}ms`);
}

async function launchChrome(profileDir, label, extraArgs = [], startupUrl = null) {
  removeSingletonFiles(profileDir);
  const stdoutPath = join(outputDir, `${label}.stdout.log`);
  const stderrPath = join(outputDir, `${label}.stderr.log`);
  const stdout = openSync(stdoutPath, 'a', 0o600);
  const stderr = openSync(stderrPath, 'a', 0o600);
  const launchArgs = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-session-crashed-bubble',
    '--window-size=900,700',
    ...extraArgs,
    ...(startupUrl ? [startupUrl] : []),
  ];
  record({ type: 'launch-start', label, profileDir, chromePath, args: launchArgs.map(sanitizedUrl) });
  const child = spawn(chromePath, launchArgs, {
    stdio: ['ignore', stdout, stderr],
    detached: false,
  });
  closeSync(stdout);
  closeSync(stderr);
  const port = await waitForPort(profileDir, child);
  record({ type: 'launch-ready', label, pid: child.pid, port, stdoutPath, stderrPath });
  return { child, port, launchArgs, stdoutPath, stderrPath };
}

async function pageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`CDP list returned HTTP ${response.status}`);
  return (await response.json()).filter((target) => target.type === 'page');
}

async function evaluate(port, targetId, expression) {
  const connection = await CdpConnection.connect(port);
  try {
    const sessionId = await connection.attachTarget(targetId);
    await connection.send('Runtime.enable', {}, sessionId);
    const result = await connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  } finally {
    connection.close();
  }
}

async function inspectState(port, origin) {
  const targets = await pageTargets(port);
  const safeTargets = targets.map((target, tabIndex) => ({
    tabIndex,
    targetId: target.id,
    title: target.title,
    url: sanitizedUrl(target.url),
  }));
  const first = targets.find((target) => target.url === `${origin}/page-a`);
  let page = null;
  if (first) {
    page = await evaluate(port, first.id, `(() => ({
      ready: document.readyState,
      inputLength: document.querySelector('#draft')?.value?.length ?? -1,
      scrollY: Math.round(scrollY),
      frameCount: document.querySelectorAll('iframe').length,
      frameInputLength: document.querySelector('iframe')?.contentDocument?.querySelector('#frame-draft')?.value?.length ?? -1
    }))()`);
  }
  return { targets: safeTargets, page };
}

async function closeChrome(instance, label, graceful = true) {
  if (!instance || instance.child.exitCode !== null) return;
  if (graceful) {
    try {
      const connection = await CdpConnection.connect(instance.port);
      await connection.send('Browser.close');
      connection.close();
    } catch {}
  } else {
    try { instance.child.kill('SIGKILL'); } catch {}
  }
  const deadline = Date.now() + 10_000;
  while (instance.child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (instance.child.exitCode === null) {
    try { instance.child.kill('SIGKILL'); } catch {}
  }
  const profileDir = instance.profileDir ? resolve(instance.profileDir) : null;
  if (profileDir?.startsWith(`${profilesDir}/`)) {
    try {
      execFileSync('pkill', ['-f', `--user-data-dir=${profileDir}`], { stdio: 'ignore' });
    } catch {}
  }
  record({ type: 'launch-stopped', label, graceful, exitCode: instance.child.exitCode, signal: instance.child.signalCode });
}

function cloneProfile(source, destination) {
  if (existsSync(destination)) return;
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  chmodSync(destination, 0o700);
  removeSingletonFiles(destination);
}

function fixtureServer() {
  const filler = '<div style="height:2400px">restore probe</div>';
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/frame') {
      response.end('<!doctype html><title>Frame</title><input id="frame-draft" autocomplete="off">');
      return;
    }
    if (request.url === '/page-a') {
      response.end(`<!doctype html><title>Restore A</title><input id="draft" autocomplete="off"><iframe src="/frame"></iframe>${filler}`);
      return;
    }
    if (request.url === '/page-b') {
      response.end('<!doctype html><title>Restore B</title><p>second tab</p>');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  return server;
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return server.address().port;
}

async function seedSession(profileDir, origin) {
  normalizePreferences(profileDir);
  const instance = await launchChrome(profileDir, 'seed', [], `${origin}/page-a`);
  instance.profileDir = profileDir;
  const connection = await CdpConnection.connect(instance.port);
  try {
    await connection.send('Target.createTarget', { url: `${origin}/page-b` });
  } finally {
    connection.close();
  }
  const deadline = Date.now() + 10_000;
  let target = null;
  while (Date.now() < deadline && !target) {
    target = (await pageTargets(instance.port)).find((entry) => entry.url === `${origin}/page-a`);
    if (!target) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!target) throw new Error('seed page did not load');
  await evaluate(instance.port, target.id, `(() => {
    const input = document.querySelector('#draft');
    input.value = 'RESTORE_SENTINEL';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const frameInput = document.querySelector('iframe').contentDocument.querySelector('#frame-draft');
    frameInput.value = 'FRAME_SENTINEL';
    frameInput.dispatchEvent(new Event('input', { bubbles: true }));
    scrollTo(0, 1200);
    return true;
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
  record({ type: 'seed-state', state: await inspectState(instance.port, origin) });
  return instance;
}

async function runVariant({ name, crashedProfile, origin, clean, restoreSwitch, startupUrl }) {
  const profileDir = join(profilesDir, name);
  cloneProfile(crashedProfile, profileDir);
  if (clean) normalizePreferences(profileDir, { restore: true, clean: true });
  const instance = await launchChrome(
    profileDir,
    name,
    restoreSwitch ? ['--restore-last-session'] : [],
    startupUrl ? `${origin}/blank-start` : null
  );
  instance.profileDir = profileDir;
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    const state = await inspectState(instance.port, origin);
    const result = {
      name,
      clean,
      restoreSwitch,
      explicitStartupUrl: Boolean(startupUrl),
      restoredA: state.targets.some((target) => target.url === `${origin}/page-a`),
      restoredB: state.targets.some((target) => target.url === `${origin}/page-b`),
      state,
      preferences: copyPreferences(profileDir, name),
    };
    writeJsonAtomic(join(outputDir, `${name}.result.json`), result);
    record({ type: 'variant-result', ...result });
    return result;
  } finally {
    await closeChrome(instance, name, true);
  }
}

const server = fixtureServer();
let active = null;
try {
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const chromeVersion = execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim();
  record({ type: 'probe-start', chromeVersion, outputDir, origin: sanitizedUrl(origin) });

  const seedProfile = join(profilesDir, 'seed-profile');
  active = await seedSession(seedProfile, origin);
  await closeChrome(active, 'seed-clean-close', true);
  active = null;

  const clean = await launchChrome(seedProfile, 'clean-restore');
  clean.profileDir = seedProfile;
  active = clean;
  await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
  const cleanState = await inspectState(clean.port, origin);
  writeJsonAtomic(join(outputDir, 'clean-restore.result.json'), cleanState);
  record({ type: 'clean-restore-result', state: cleanState });

  await closeChrome(clean, 'crash-baseline', false);
  active = null;
  const crashedProfile = join(profilesDir, 'crashed-baseline');
  cloneProfile(seedProfile, crashedProfile);
  copyPreferences(crashedProfile, 'crashed-baseline');

  const variants = [];
  for (const config of [
    { name: 'settings-only', clean: false, restoreSwitch: false, startupUrl: false },
    { name: 'normalized', clean: true, restoreSwitch: false, startupUrl: false },
    { name: 'restore-switch', clean: false, restoreSwitch: true, startupUrl: false },
    { name: 'normalized-switch-explicit', clean: true, restoreSwitch: true, startupUrl: true },
  ]) {
    variants.push(await runVariant({ ...config, crashedProfile, origin }));
  }

  const summary = {
    chromeVersion,
    cleanRestore: cleanState,
    variants: variants.map((variant) => ({
      name: variant.name,
      restoredA: variant.restoredA,
      restoredB: variant.restoredB,
      inputLength: variant.state.page?.inputLength ?? null,
      frameInputLength: variant.state.page?.frameInputLength ?? null,
      scrollY: variant.state.page?.scrollY ?? null,
      targetCount: variant.state.targets.length,
    })),
  };
  writeJsonAtomic(join(outputDir, 'summary.json'), summary);
  record({ type: 'probe-complete', summary });
} catch (error) {
  record({ type: 'probe-failed', message: error.stack ?? error.message });
  process.exitCode = 1;
} finally {
  if (active) await closeChrome(active, 'final-cleanup', false);
  await new Promise((resolveClose) => server.close(resolveClose));
}
