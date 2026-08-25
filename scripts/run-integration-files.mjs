import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const requested = process.argv.slice(2);
const runDir = resolve(
  process.env.WEB_PLANE_INTEGRATION_RUN_DIR ?? join(repo, 'logs', `integration-${stamp()}`)
);
if (runDir !== repo && !runDir.startsWith(`${repo}/`)) {
  throw new Error(`integration evidence must stay inside the repository: ${runDir}`);
}

const allFiles = readdirSync(join(repo, 'tests', 'integration'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join('tests', 'integration', name));
const files = requested.length
  ? requested.map((file) => file.startsWith('tests/') ? file : join('tests', 'integration', file))
  : allFiles;
for (const file of files) {
  if (!allFiles.includes(file)) throw new Error(`unknown integration test file: ${file}`);
}

const checkpointsDir = join(runDir, 'checkpoints');
const inputsDir = join(runDir, 'inputs');
mkdirSync(checkpointsDir, { recursive: true, mode: 0o700 });
mkdirSync(inputsDir, { recursive: true, mode: 0o700 });
const resultsPath = join(runDir, 'results.jsonl');

function sourceFingerprint() {
  const hash = createHash('sha256');
  const skip = new Set(['.git', '.playwright-cli', 'logs', 'node_modules', 'tmp']);
  const walk = (dir, relative = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const rel = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) {
        hash.update(rel);
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  walk(repo);
  return hash.digest('hex');
}

const fingerprint = sourceFingerprint();

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  } catch {
    return fallback;
  }
}

const inputStamp = stamp();
writeFileSync(
  join(inputsDir, `input-${inputStamp}.json`),
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    command: [process.execPath, fileURLToPath(import.meta.url), ...requested],
    files,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    commit: git(['rev-parse', 'HEAD']).trim() || null,
    sourceFingerprint: fingerprint,
    status: git(['status', '--short']),
  }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' }
);
writeFileSync(
  join(inputsDir, `working-tree-${inputStamp}.patch`),
  git(['diff', 'HEAD', '--binary']),
  { mode: 0o600, flag: 'wx' }
);

function safeName(file) {
  return basename(file).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function checkpointPath(file) {
  return join(checkpointsDir, `${safeName(file)}.json`);
}

function completed(file) {
  try {
    const checkpoint = JSON.parse(readFileSync(checkpointPath(file), 'utf8'));
    return checkpoint.file === file && checkpoint.status === 'passed' &&
      checkpoint.sourceFingerprint === fingerprint;
  } catch {
    return false;
  }
}

function record(event) {
  appendFileSync(
    resultsPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    { mode: 0o600 }
  );
  chmodSync(resultsPath, 0o600);
}

async function runFile(file) {
  if (completed(file)) {
    record({ event: 'skip', file, reason: 'successful checkpoint exists' });
    console.log(`SKIP ${file} (checkpoint)`);
    return true;
  }

  const attempt = stamp();
  const logPath = join(runDir, `${safeName(file)}-${attempt}.log`);
  const command = [process.execPath, '--test', '--test-concurrency=1', file];
  const started = Date.now();
  record({ event: 'start', file, command, log: logPath });
  console.log(`START ${file}`);

  const child = spawn(command[0], command.slice(1), {
    cwd: repo,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const writeChunk = (stream, chunk) => {
    stream.write(chunk);
    appendFileSync(logPath, chunk, { mode: 0o600 });
  };
  child.stdout.on('data', (chunk) => writeChunk(process.stdout, chunk));
  child.stderr.on('data', (chunk) => writeChunk(process.stderr, chunk));
  const exit = await new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    child.once('error', (error) => resolveExit({ code: null, signal: null, error }));
  });
  const durationMs = Date.now() - started;
  const passed = exit.code === 0;
  record({
    event: 'end',
    file,
    status: passed ? 'passed' : 'failed',
    exitCode: exit.code,
    signal: exit.signal,
    error: exit.error?.message ?? null,
    durationMs,
    log: logPath,
  });
  if (passed) {
    writeFileSync(
      checkpointPath(file),
      `${JSON.stringify({
        file,
        status: 'passed',
        durationMs,
        sourceFingerprint: fingerprint,
        timestamp: new Date().toISOString(),
      })}\n`,
      { mode: 0o600, flag: 'wx' }
    );
  }
  console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${(durationMs / 1000).toFixed(1)}s)`);
  return passed;
}

let failed = 0;
for (const file of files) {
  if (!(await runFile(file))) failed++;
}
console.log(`Evidence: ${runDir}`);
process.exitCode = failed ? 1 : 0;
