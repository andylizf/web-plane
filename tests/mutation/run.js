/**
 * Do the tests actually catch the bug they were written for?
 *
 * This repo has already been burned by a check that passed either way: `show`
 * verified a hidden window with two queries that a miniaturized window satisfies
 * (Chrome's own window state, and CGWindowList's *all* windows), printed "Window
 * shown", and exited 0 over a window sitting in the Dock. A test suite that
 * repeated that mistake would be worse than none, because it would certify it.
 *
 * So each mutation below puts a known bug back into a throwaway copy of this
 * checkout and demands that the integration suite go red. A mutation that
 * survives is reported as a failure of the *tests*, not of the product.
 *
 *   node tests/mutation/run.js [name...]
 *
 * Run it after the unmutated suite passes — "it fails when broken" only means
 * something next to "it passes when whole".
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKDIR = join(REPO, 'tmp', 'mutants');

/**
 * `from` must appear exactly once. If a rewrite of the fix moves or reshapes the
 * line, this harness fails loudly rather than quietly testing nothing — the
 * silent-no-op is the exact failure mode it exists to prevent.
 */
const MUTATIONS = [
  {
    name: 'show-signal-forgets-deminiaturize',
    describes:
      'reverts the dylib half of d787200: SIGUSR2 restores alpha but leaves the window ' +
      'miniaturized, so it comes back opaque, correctly positioned, and still in the Dock',
    // Naming the test that must go red is the difference between "the suite
    // noticed" and "something went wrong somewhere" — a mutation caught by an
    // unrelated crash would prove nothing about the assertion it targets.
    //
    // Note the test named here is the signal-level one, not the end-to-end round
    // trip: on macOS 26 / Chrome 150 the CDP half of `show` deminiaturizes the
    // window on its own, so the round trip passes with this bug reverted. That
    // was measured, not assumed — see tests/tools/trace-minimize.mjs.
    //
    // The restore call is makeKeyAndOrderFront:, not deminiaturize:, and the
    // difference is load-bearing rather than cosmetic — Chromium clears its
    // in-flight Dock miniaturization only in makeKeyAndOrderFront: and
    // orderOut:, so deminiaturize: is undone about a second later by
    // _regularMinimizeToDock. Reverting this line to deminiaturize: reproduces
    // the intermittent failure rather than a clean one, which is why the
    // mutation removes the call outright.
    expect: 'the show signal undoes the miniaturize, not just the alpha',
    edits: [
      {
        file: 'native/window_suppress.m',
        from: 'if ([w isMiniaturized]) [w makeKeyAndOrderFront:nil];',
        to: '/* mutation: alpha restored, miniaturize left in place */',
      },
    ],
  },
  {
    name: 'verifier-cannot-see-a-window-in-the-dock',
    describes:
      "reverts the verifier half of d787200: `show` goes back to asking CGWindowList for *all* " +
      'windows, which a miniaturized window satisfies with its alpha and bounds intact',
    expect: "web-plane's own window-server query notices a window in the Dock",
    edits: [
      {
        file: 'lib/window.js',
        from: '$.kCGWindowListOptionOnScreenOnly',
        to: '$.kCGWindowListOptionAll',
      },
    ],
  },
  {
    name: 'hide-degrades-to-minimize',
    describes:
      'stops `hide` from cloaking (as when the DYLD hook is not loaded at all), leaving a ' +
      'window that is merely minimized — visible in the Dock, still stealing focus',
    expect: 'hide leaves the window transparent and off screen',
    edits: [
      {
        file: 'lib/window.js',
        from: "if (chrome.managed) {\n      process.kill(chrome.pid, 'SIGUSR1');",
        to: "if (false) {\n      process.kill(chrome.pid, 'SIGUSR1');",
      },
    ],
  },
];

const SKIP = new Set(['.git', 'node_modules', 'tmp', 'logs', '.playwright-cli']);

/**
 * Copy the working tree — not `git archive` — so a mutation runs against the
 * code as it is right now, including changes nobody has committed yet.
 *
 * Copied entry by entry because `cpSync` refuses to write a directory into its
 * own subtree, and the destination has to stay inside the repo (`tmp/`) rather
 * than land in /tmp, where it would be invisible and wiped on reboot.
 */
function copyCheckout(dest) {
  rmSync(dest, { recursive: true, force: true });
  const walk = (rel) => {
    mkdirSync(join(dest, rel), { recursive: true });
    for (const entry of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) cpSync(join(REPO, child), join(dest, child));
    }
  };
  walk('');
}

function applyEdits(root, edits) {
  for (const { file, from, to } of edits) {
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`mutation target missing: ${file}`);
    const body = readFileSync(path, 'utf8');
    const hits = body.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(
        `mutation target appears ${hits} times in ${file}, expected exactly 1:\n  ${from}\n` +
          `The code it describes has moved or changed shape — update this mutation rather than ` +
          `letting it silently test nothing.`
      );
    }
    writeFileSync(path, body.replace(from, to));
  }
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.name)) : MUTATIONS;
if (!selected.length) {
  console.error(`no such mutation. known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

const results = [];
for (const mutation of selected) {
  const root = join(WORKDIR, mutation.name);
  console.log(`\n=== mutation: ${mutation.name} ===`);
  console.log(`    ${mutation.describes}`);
  copyCheckout(root);
  applyEdits(root, mutation.edits);

  const run = spawnSync(process.execPath, ['--test', 'tests/integration/hide-show.test.js'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    // A mutant drives a browser into states the product never expects, so it can
    // stall in a way the suite itself never would. Bound it: a hung mutant must
    // read as "not evaluated", not as a gate that quietly never finishes.
    timeout: 8 * 60 * 1000,
  });
  const out = (run.stdout ?? '') + (run.stderr ?? '');
  const failing = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  // A run that could not observe anything is not evidence either way, and must
  // never be counted as the mutation being caught.
  const inconclusive = out.includes('cannot observe window visibility');
  const caught = !inconclusive && failing.includes(mutation.expect);
  results.push({ name: mutation.name, expect: mutation.expect, caught, inconclusive, failing, out });

  console.log(
    `    exit ${run.status} — ${inconclusive ? 'INCONCLUSIVE' : caught ? 'CAUGHT' : 'SURVIVED'}`
  );
  for (const f of failing) console.log(`      failing test: ${f}`);
  if (!caught) {
    console.log('--- output of the mutant ---');
    console.log(out.split('\n').slice(-60).join('\n'));
  }
}

console.log('\n=== mutation summary ===');
for (const r of results) {
  const verdict = r.inconclusive ? 'INCONCLUSIVE' : r.caught ? 'caught      ' : 'SURVIVED    ';
  console.log(`${verdict} ${r.name}  (expected to fail: "${r.expect}")`);
}

const bad = results.filter((r) => !r.caught);
if (bad.length) {
  const inconclusive = bad.filter((r) => r.inconclusive).length;
  console.error(
    `\nFAIL: ${bad.length} mutation(s) were not caught by the test named for them` +
      (inconclusive ? ` (${inconclusive} could not be evaluated: no observable display)` : '') +
      `.\nThe integration suite does not currently prove what it claims to.`
  );
  process.exit(1);
}
console.log(`\nOK: every mutation was caught by the test written to catch it.`);
