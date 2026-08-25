# Lane Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Resolve issues #17–#29 by making lane operations safe, discoverable, observable, frame-aware, and tab-scoped.

**Architecture:** Keep agent-browser 0.34.0 as the page-operation engine. Add policy and lifecycle behavior at web-plane's lane boundary, plus a detached CDP observer for evidence agent-browser does not retain. Store all runtime state under web-plane's existing runtime directory with mode-0600 logs.

**Tech Stack:** Node.js 24 ESM, Chrome DevTools Protocol over WebSocket, node:test, macOS Chrome, existing Objective-C launch/runtime integration.

---

### Task 1: Lane command surface and safe translations

**Files:**
- Create: `lib/lane-commands.js`
- Modify: `bin/web-plane.js`
- Modify: `lib/cdp.js`
- Test: `tests/unit/lane-commands.test.js`
- Test: `tests/unit/cli.test.js`

**Step 1: Write failing tests**

Cover lane help, top-level unknown-command failure with nearest suggestion,
`type` translating to `fill`, `type --append` preserving append behavior,
`clear <selector>` translating to an empty fill, tab-scoped close, navigation
wait parsing, and covered-click retry policy.

**Step 2: Verify red**

Run `node --test tests/unit/lane-commands.test.js tests/unit/cli.test.js`.
Expected: failures for the new exports and CLI behavior.

**Step 3: Implement minimal command policy**

Export pure parsers/translators from `lib/lane-commands.js`. Dispatch
`lane --help` before lane mapping lookup. Reject unknown top-level commands with
exit 2. Route `lane close` through `tab close`; remove its mapping only after a
successful close. Run `scrollintoview` and one retry only when a click fails with
agent-browser's covered-element diagnostic.

**Step 4: Verify green**

Run the same focused tests, then `npm run test:unit`.

**Step 5: Commit**

Commit as `Make lane commands safe and discoverable`.

### Task 2: Managed-profile recovery and browser logs

**Files:**
- Create: `lib/profile-runtime.js`
- Modify: `lib/config.js`
- Modify: `lib/commands.js`
- Modify: `lib/cdp.js`
- Modify: `lib/install.js`
- Test: `tests/unit/profile-runtime.test.js`
- Test: `tests/doctor/doctor.test.js`

**Step 1: Write failing tests**

Use temporary profiles to prove preferences are updated atomically, unrelated
keys survive, a previous file is backed up before replacement, stale crash state
becomes clean, autofill/password prompts are disabled, old browser logs rotate,
and death messages contain exact evidence paths.

**Step 2: Verify red**

Run `node --test tests/unit/profile-runtime.test.js`.

**Step 3: Implement minimal runtime hardening**

Normalize only an idle managed profile. Merge
`--disable-session-crashed-bubble` and `--enable-logging` into managed launch
configuration, set `CHROME_LOG_FILE`, rotate an existing log, and append
timestamped lifecycle records. Bump `RUNTIME_VERSION` because install must
deploy the new launch arguments.

**Step 4: Verify green**

Run focused tests and `npm run test:doctor`.

**Step 5: Commit**

Commit as `Recover cleanly from browser crashes`.

### Task 3: Persistent lane diagnostics

**Files:**
- Create: `lib/cdp-client.js`
- Create: `lib/lane-monitor.js`
- Create: `lib/lane-events.js`
- Modify: `lib/cdp.js`
- Test: `tests/unit/lane-events.test.js`
- Test: `tests/integration/lane-diagnostics.test.js`

**Step 1: Write failing tests**

Unit-test JSONL filtering, `netlog --failed`, since/clear parsing, redaction-free
local retention, and warning selection. Integration-test a console error, thrown
exception, failed fetch with `errorText`, child-frame error, tab loss, and monitor
restart on re-attach.

**Step 2: Verify red**

Run `node --test tests/unit/lane-events.test.js` and the one integration file on
mac-mini.

**Step 3: Implement the observer**

Connect to the browser WebSocket, attach to the pinned target with flattened CDP
sessions, auto-attach iframe targets, enable Runtime and Network, correlate
request IDs, and append one timestamped JSON object per event. Start only after
the monitor writes a ready record; replace old monitor PID state on re-attach;
stop it on lane close. Warn after successful mutating commands when new failures
arrive.

**Step 4: Verify green**

Run unit and diagnostic integration tests.

**Step 5: Commit**

Commit as `Record lane console and network failures`.

### Task 4: Frame, focus, canvas, and wait behavior

**Files:**
- Create: `lib/page-diagnostics.js`
- Modify: `lib/cdp.js`
- Modify: `lib/lane-commands.js`
- Test: `tests/unit/page-diagnostics.test.js`
- Test: `tests/integration/lane-page-behavior.test.js`

**Step 1: Write failing tests**

Cover all-frame eval result/error formatting, same- and cross-origin frames,
focused iframe element reporting, body-focus warning, large-canvas detection,
default network-idle wait, explicit selector/load wait, timeout, and no-wait.

**Step 2: Verify red**

Run the focused unit tests and a one-page real-Chrome smoke on mac-mini.

**Step 3: Implement minimal behavior**

Evaluate in every default execution context discovered by flattened CDP. Query
focus without changing it, print the target before key dispatch, and append the
canvas screenshot hint after plain snapshots. After attach or a navigation
command, invoke the parsed wait condition; return a nonzero diagnostic on timeout.

**Step 4: Verify green**

Run focused tests and all lane integration tests.

**Step 5: Commit**

Commit as `Make lanes frame-aware and wait for usable pages`.

### Task 5: Profile identity evidence

**Files:**
- Modify: `lib/profiles.js`
- Test: `tests/unit/profiles.test.js`

**Step 1: Write failing tests**

Create fake Chrome Preferences containing zero, one, and multiple
`account_info` emails. Assert that Google hosts show known identities, counts do
not duplicate, and absent identity is explicitly marked unknown for known
multi-account providers.

**Step 2: Verify red**

Run `node --test tests/unit/profiles.test.js`.

**Step 3: Implement identity annotations**

Read only account metadata from Default/Preferences; never inspect tokens. Add
identity annotations to known Google multi-account hosts and update the footer
to warn that a host does not prove the required identity is present.

**Step 4: Verify green**

Run focused and full unit tests.

**Step 5: Commit**

Commit as `Show profile identities when Chrome records them`.

### Task 6: Documentation, packaging, and complete verification

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.claude-plugin/plugins/browser/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/plugins/browser/skills/browser/SKILL.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml` if new integration files require explicit coverage

**Step 1: Update user-facing documentation**

Document safe fill/append semantics, semantic find, auto-scroll, waits,
all-frame eval, focus reporting, diagnostics paths, crash recovery, canvas
fallback, tab-scoped close, and profile identity limits. Keep all repository text
in English.

**Step 2: Bump versions**

Bump package and plugin versions together and update the lockfile.

**Step 3: Local verification**

Run `npm ci`, `npm run check`, `npm run test:unit`, `npm run test:doctor`, JSON
manifest parsing, `git diff --check`, and a privacy audit against all additions.

**Step 4: Mac-mini pre-flight and full run**

Install an isolated package/runtime in a dedicated worktree. Smoke one test per
behavior group. Run all integration files with the resumable per-file JSONL
runner and preserve full inputs, stdout, stderr, commit, and patch in
`logs/issues-17-29-20260825/`.

**Step 5: Commit, push, and verify CI**

Commit with `Fixes #17` through `Fixes #29`, push to the user-owned public
repository after privacy audit, watch CI to completion, and diagnose any failure
before reporting completion.
