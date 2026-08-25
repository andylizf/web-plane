# Chrome-native Session Restore Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Recover crashed web-plane sessions through Chrome's native session restore and safely rebind named lanes to restored tabs.

**Architecture:** Chrome remains responsible for persisted browsing state. web-plane adds a private lane index, backs up Chrome session files before the first restore attempt, binds lanes only to unique restored targets, and quarantines a restore only after it demonstrably kills Chrome.

**Tech Stack:** Node.js 24 ESM, Chrome DevTools Protocol, agent-browser 0.34.0, node:test, macOS Chrome.

---

### Task 1: Verify installed Chrome restore behavior on mac-mini

**Files:**
- Create: `scripts/probe-native-session-restore.mjs`
- Evidence: `logs/native-session-restore-20260825/smoke/`

**Step 1: Write a resumable probe**

Create an isolated project-local Chrome profile and HTTP fixture. Log each
phase as JSONL with timestamp, Chrome version, exact launch arguments, profile
path, target URLs, form value length, frame count, and scroll position. Keep
stdout/stderr and a copy of Preferences alongside the result. Do not record
form values or URL query strings.

**Step 2: Run one clean-exit smoke on mac-mini**

Run the probe with Chrome's last-session preference, an explicit startup URL,
and no restore switch. Expected: the output states whether native tabs and page
state returned.

**Step 3: Run one crash-exit smoke on mac-mini**

Kill only the isolated Chrome profile process and relaunch with each viable
startup combination. Expected: one combination restores without displaying a
blocking recovery bubble. Record the observed combination for Task 3.

Observed on Chrome 151.0.7922.138: `--restore-last-session` restored both tabs;
the startup preference alone did not. The crash-bubble switch did not affect
the result. Live form and scroll changes were not reliably present after
SIGKILL and are outside the recovery guarantee.

**Step 4: Commit the probe and design evidence contract**

Commit as `Probe Chrome native session restore`.

### Task 2: Add private, durable lane recovery state

**Files:**
- Create: `lib/lane-state.js`
- Modify: `lib/cdp.js`
- Modify: `lib/lane-monitor.js`
- Test: `tests/unit/lane-state.test.js`
- Test: `tests/unit/lane.test.js`

**Step 1: Write failing tests**

Cover mode-0700 directories, mode-0600 atomic files, legacy `{session,port}`
records, full state round trips, top-frame navigation updates, and retained
append-only navigation evidence.

**Step 2: Verify red on mac-mini**

Run `node --test tests/unit/lane-state.test.js tests/unit/lane.test.js` in the
isolated worktree. Expected: missing module/export failures.

**Step 3: Implement the state module**

Move lane-file ownership out of `lib/cdp.js`. Use a hashed filename, atomic
replacement, explicit permissions, schema versioning, and merge updates from
the monitor. Preserve reads of existing lane files during migration.

**Step 4: Verify green on mac-mini**

Run the focused tests, then `npm run test:unit`.

**Step 5: Commit**

Commit as `Persist private lane recovery state`.

### Task 3: Preserve and restore Chrome's native session

**Files:**
- Modify: `lib/profile-runtime.js`
- Modify: `lib/commands.js`
- Modify: `lib/cdp.js`
- Modify: `lib/config.js`
- Test: `tests/unit/profile-runtime.test.js`
- Test: `tests/unit/lane.test.js`
- Test: `tests/doctor/doctor.test.js`

**Step 1: Write failing tests**

Cover the last-session preference, the launch behavior proven by Task 1,
backup contents and permissions, proof that no session file is removed before
backup, one quarantine after a failed restore, and a clean second attempt.

**Step 2: Verify red on mac-mini**

Run the three focused test files. Expected: assertions fail against the current
session deletion and launch configuration.

**Step 3: Implement backup and launch policy**

Add discovery for current and legacy Chrome session files. Copy the initial
restore set into a unique backup, verify every copied file, preserve the live
set for attempt one, and move it into a quarantine only after that attempt
publishes a port and dies. Separate process cleanup from session-data cleanup.
Apply the startup behavior observed in Task 1. Bump the runtime protocol if a
managed launch argument changes.

**Step 4: Verify green on mac-mini**

Run focused unit/doctor tests and inspect one backup tree from the smoke.

**Step 5: Commit**

Commit as `Restore Chrome sessions before clean fallback`.

### Task 4: Rebind lanes to restored targets

**Files:**
- Create: `lib/lane-recovery.js`
- Modify: `lib/cdp.js`
- Modify: `lib/lane-monitor.js`
- Test: `tests/unit/lane-recovery.test.js`
- Test: `tests/integration/lane-recovery.test.js`

**Step 1: Write failing tests**

Cover unique URL/title matching, duplicate URL ambiguity, no index-only match,
target selection by CDP target ID, new strict pinning, monitor replacement, new
port persistence, and refusal to replay the interrupted command.

**Step 2: Verify red on mac-mini**

Run the unit file and one real-Chrome recovery smoke. Expected: no recovery
module and the current browser-death error.

**Step 3: Implement one-shot recovery**

When a mapped lane has no live browser, launch its profile through Task 3,
enumerate page targets, resolve a unique candidate, reconnect agent-browser,
select the target by CDP target ID with strict pinning, restart diagnostics, and
update lane state. Exit with a recovery diagnostic without dispatching the
original command.

**Step 4: Verify green on mac-mini**

Run focused unit and integration tests. Repeat the duplicate-URL case and
confirm neither candidate receives input.

**Step 5: Commit**

Commit as `Rebind lanes after Chrome session restore`.

### Task 5: Document behavior and verify the full release

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `plugins/browser/skills/browser/SKILL.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/browser/.claude-plugin/plugin.json`
- Modify: `.github/workflows/ci.yml`

**Step 1: Document the recovery contract**

Explain Chrome-owned page recovery, web-plane-owned lane rebinding, no command
replay, ambiguity refusal, backup paths, and clean fallback. Keep all repository
text in English.

**Step 2: Bump versions together**

Bump the package and both plugin manifests. Update the lockfile. If the runtime
protocol changed, ensure `doctor` rejects the previous version.

**Step 3: Run the mac-mini pre-flight**

In an exact-commit isolated worktree, run `npm ci`, syntax checks, unit tests,
doctor tests, JSON parsing, and one recovery smoke. Write timestamped per-step
records under `logs/native-session-restore-20260825/preflight/`.

**Step 4: Run full mac-mini verification**

Run all integration files through the resumable per-file runner, the native
restore integration, and the mutation suite. Preserve command, commit, stdout,
stderr, duration, and status for every item.

**Step 5: Privacy audit and commit**

Inspect every addition for profile paths, account identifiers, URLs, tokens,
cookies, headers, request bodies, and machine-specific information. Commit as
`Release Chrome native session recovery`.

**Step 6: Push and verify CI**

Push the user-owned public repository, watch every CI job to completion, and
diagnose any failure before reporting success. Recheck the open issue queue.
