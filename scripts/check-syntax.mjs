/**
 * Parse every JavaScript file in the repo.
 *
 * The CLI imports its command modules lazily, so a syntax error in, say,
 * `lib/install.js` does not surface until someone runs `web-plane install` — on
 * a fresh machine, which is the worst possible moment to find out. This is the
 * cheapest check that makes every file's syntax a build-time fact.
 *
 * It is deliberately not a linter: this repo has no lint configuration, and
 * inventing a house style here would be a change nobody asked for.
 */
import { readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'tmp', 'logs', '.playwright-cli']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

const files = walk(REPO).sort();
const broken = [];
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) broken.push({ file: relative(REPO, file), err: res.stderr.trim() });
}

for (const b of broken) console.error(`\n✗ ${b.file}\n${b.err}`);
console.log(`${files.length - broken.length}/${files.length} JavaScript files parse.`);
process.exit(broken.length ? 1 : 0);
