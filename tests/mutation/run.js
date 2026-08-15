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
    name: 'hidden-native-panel-is-not-intercepted',
    describes:
      'lets a hidden-session Save/Open panel enter its running phase, where public path setters ' +
      'can no longer select the requested URL and the UI can surface to the user',
    suite: 'tests/integration/panel-control.test.js',
    expect: 'native Save panel reports state and accepts one exact non-existing path',
    edits: [
      {
        file: 'native/panel_control.m',
        from: 'if (!sessionIsHidden() || gPendingPanel || !completion) return NO;',
        to: 'if (YES || gPendingPanel || !completion) return NO;',
      },
    ],
  },
  {
    name: 'agent-open-panel-is-opaque',
    describes:
      'initializes the remote Open-panel service at alpha 1, exposing automation UI while the ' +
      'browser itself remains hidden',
    suite: 'tests/integration/panel-control.test.js',
    expect: 'native Open panel selects and accepts the exact existing path',
    edits: [
      {
        file: 'native/window_suppress.m',
        from:
          'static void cloakAgentPanel(NSWindow *w) {\n' +
          '    if (!isAgentPanelWindow(w)) return;\n' +
          '    [w setAlphaValue:0.0];',
        to:
          'static void cloakAgentPanel(NSWindow *w) {\n' +
          '    if (!isAgentPanelWindow(w)) return;\n' +
          '    [w setAlphaValue:1.0];',
      },
    ],
  },
  {
    name: 'show-signal-forgets-deminiaturize',
    describes:
      'reverts the dylib half of d787200: SIGUSR2 restores alpha but leaves the window ' +
      'miniaturized, so it comes back opaque, correctly positioned, and still in the Dock',
    // Naming the test that must go red is the difference between "the suite
    // noticed" and "something went wrong somewhere" — a mutation caught by an
    // unrelated crash would prove nothing about the assertion it targets.
    //
    // The signal-level test isolates this from the end-to-end round trip:
    // Chrome's CDP half also deminiaturizes, masking a broken signal handler.
    //
    // The restore call is makeKeyAndOrderFront:, not deminiaturize:, and the
    // difference is load-bearing rather than cosmetic — Chromium clears its
    // in-flight Dock miniaturization only in makeKeyAndOrderFront: and
    // orderOut:, so deminiaturize: is undone about a second later by
    // _regularMinimizeToDock. Reverting this line to deminiaturize: reproduces
    // the intermittent failure rather than a clean one, which is why the
    // mutation removes the call outright.
    suite: 'tests/integration/window-scope.test.js',
    expect: 'the show signal recovers a minimized browser without Accessibility permission',
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
    name: 'verifier-mistakes-a-sleeping-display-for-a-dock',
    describes:
      'removes the blind-spot guard: the verifier goes back to reading an empty on-screen ' +
      'list as "this window is miniaturized", which it is for every window of every ' +
      'application while the display sleeps',
    // A unit suite, not the integration one: the state this mutation is about
    // cannot be staged with a browser, because staging it means putting the
    // display to sleep — which locks the machine on any Mac with an immediate
    // lock delay, and would blind the integration suite's own assertions anyway.
    suite: 'tests/unit/window-verify.test.js',
    expect: 'a sleeping display is not evidence that our window is in the Dock',
    edits: [
      {
        file: 'lib/window.js',
        from: '  if (compositorBlindSpot(screen)) return null;',
        to: '  /* mutation: an idle compositor is read as a fact about this window */',
      },
    ],
  },
  {
    name: 'hide-degrades-to-minimize',
    describes:
      'stops `hide` from cloaking (as when the DYLD hook is not loaded at all), leaving a ' +
      'window that is merely minimized — visible in the Dock, still stealing focus',
    expect: 'hide is transparent and preserves browser geometry',
    edits: [
      {
        file: 'lib/window.js',
        from: "if (chrome.managed) {\n      // Arm the standing-hidden flag",
        to: "if (false) {\n      // Arm the standing-hidden flag",
      },
    ],
  },
  {
    name: 'hide-parks-browser-offscreen',
    describes:
      'restores the old -9999 frame move, which drags attached sheets offscreen and is ' +
      'clamped by macOS into a transparent edge strip',
    suite: 'tests/integration/window-scope.test.js',
    expect: 'hidden state is click-through without moving browser frames or their native UI',
    edits: [
      {
        file: 'native/window_suppress.m',
        from:
          'static void cloak(NSWindow *w) {\n' +
          '    if (!isChromeWindow(w)) return;\n' +
          '    [w setAlphaValue:0.0];',
        to:
          'static void cloak(NSWindow *w) {\n' +
          '    if (!isChromeWindow(w)) return;\n' +
          '    [w setAlphaValue:0.0];\n' +
          '    [w setFrameOrigin:NSMakePoint(-9999, -9999)];',
      },
    ],
  },
  {
    name: 'hidden-browser-keeps-hit-region',
    describes:
      'removes click-through hiding, leaving an invisible browser window to consume mouse input',
    suite: 'tests/integration/window-scope.test.js',
    expect: 'hidden state is click-through without moving browser frames or their native UI',
    edits: [
      {
        file: 'native/window_suppress.m',
        from:
          '[w setIgnoresMouseEvents:YES];\n' +
          '}\n\n' +
          '// Cloaking hides windows. It cannot stop the app from being activated',
        to:
          '/* mutation: invisible browser still receives mouse events */\n' +
          '}\n\n' +
          '// Cloaking hides windows. It cannot stop the app from being activated',
      },
    ],
  },
  {
    name: 'native-panel-cannot-activate',
    describes:
      'keeps the hidden-session activation block armed while a native panel needs human input',
    suite: 'tests/integration/window-scope.test.js',
    expect: 'hidden state is click-through without moving browser frames or their native UI',
    edits: [
      {
        file: 'native/window_suppress.m',
        from: 'return isHidden() && !gHumanUIActive;',
        to: 'return isHidden();',
      },
    ],
  },
  {
    name: 'recover-bubble-escapes-cloak',
    describes:
      'forgets that Chromium restore/download bubbles are browser-owned windows, so a hidden ' +
      'session can expose one and take focus again after a native panel closes',
    suite: 'tests/integration/window-scope.test.js',
    expect: 'hidden state is click-through without moving browser frames or their native UI',
    edits: [
      {
        file: 'native/window_suppress.m',
        from: '@"NativeWidgetMacNSWindow",',
        to: '@"MutationDoesNotMatchRestoreWindow",',
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

  // Most mutations are judged by the integration suite, which is the only place a
  // real browser and the real window server meet. A mutation whose state cannot be
  // staged with a browser names its own suite instead.
  const suite = mutation.suite ?? 'tests/integration/hide-show.test.js';
  console.log(`    judged by: ${suite}`);
  const run = spawnSync(process.execPath, ['--test', suite], {
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
