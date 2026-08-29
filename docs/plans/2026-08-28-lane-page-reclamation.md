# Lane Page Reclamation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close task-owned tabs at normal completion and conservatively reclaim abandoned hidden lanes after 24 hours without an agent command.

**Architecture:** Keep task completion at the browser-skill layer, because only the caller knows that a task ended. Use the existing detached lane monitor as the abnormal-exit backstop: persist a command-only lease timestamp, inject a per-document dirty-input tracker, observe network/download activity, and close only a hidden, unpinned, inspectable lane that is older than the configured lease. Hold the existing per-profile command lock across the final safety check and `Page.close`, detect `beforeunload` listeners before closing and retain dialog dismissal as a race backstop, and append every eligible close/skip decision to the session JSONL log.

**Tech Stack:** Node.js 24 ESM, Chrome DevTools Protocol, node:test, existing web-plane lane monitor and agent-browser 0.34.0.

---

### Task 1: Persist a command-only lane lease and explicit keep state

**Files:**
- Modify: `lib/lane-state.js`
- Modify: `tests/unit/lane-state.test.js`

**Step 1: Write failing unit tests**

Add tests proving that:

- a new lane records `openedAt` and `lastCommandAt`;
- `updateLaneTarget` may change `updatedAt` but leaves `lastCommandAt` byte-for-byte unchanged;
- `touchLaneCommand(lane, at)` changes only the command lease;
- `setLaneKeep(lane, true|false)` persists an explicit keep marker;
- `listLaneStates(session)` returns only valid hashed state records for that session and ignores staged, malformed, and foreign-session files.

**Step 2: Run the test on mac-mini and retain the red result**

Run in the isolated mac-mini worktree:

```bash
node --test tests/unit/lane-state.test.js 2>&1 | tee logs/issue32/red-lane-state.log
```

Expected: FAIL because the lease, keep, and listing APIs do not exist.

**Step 3: Implement the state APIs**

`rememberLane` initializes `openedAt`, `lastCommandAt`, and `keep: false` without resetting existing values. Export:

```js
touchLaneCommand(lane, at = new Date().toISOString())
setLaneKeep(lane, keep)
listLaneStates(session = null)
```

Keep `updatedAt` as the target-observation timestamp so page navigation never extends the command lease.

**Step 4: Run the focused test on mac-mini**

Expected: PASS, with the log retained at `logs/issue32/green-lane-state.log`.

### Task 2: Extract the per-profile command lock

**Files:**
- Create: `lib/profile-command-lock.js`
- Modify: `lib/cdp.js`
- Create: `tests/unit/profile-command-lock.test.js`

**Step 1: Write failing lock tests**

Cover exclusive acquisition, bounded waiting, dead-owner recovery after the write grace period, and token-checked release.

**Step 2: Move the existing lock implementation without behavior changes**

Export:

```js
acquireProfileCommandLock(session, { timeoutMs = 30_000 } = {})
```

Keep lock paths hashed, files mode `0600`, and the runtime directory private. Replace `cdp.js`'s private copy with the shared function.

**Step 3: Verify on mac-mini**

Run the new lock unit test and `tests/package/ui-blocker-smoke.mjs`, which already proves serialization between lanes and attaches.

### Task 3: Track page safety and make a pure reap decision

**Files:**
- Create: `lib/lane-lifecycle.js`
- Create: `tests/unit/lane-lifecycle.test.js`
- Modify: `lib/lane-monitor.js`

**Step 1: Write failing pure-decision tests**

`laneReapDecision(...)` must return a named skip reason for:

- lease younger than 24 hours;
- explicit keep;
- visible or unverifiably hidden session;
- target mismatch;
- missing/failed frame inspection;
- unsubmitted input in any frame;
- playing `<audio>` or `<video>` in any frame;
- an active network request or download.

It returns `eligible` only when every gate is known and clear. An invalid timestamp is `inspection-unknown`, never eligible.

**Step 2: Add the lifecycle tracker**

Inject one idempotent script with `Page.addScriptToEvaluateOnNewDocument` before lane navigation and evaluate it in the current document. It records trusted `input`/`change`, clears on a non-cancelled form submit or reset, and exposes only booleans through a symbol-keyed page object. The safety probe evaluates every available frame and treats a missing tracker or frame error as unknown.

**Step 3: Extend monitor evidence**

The existing request map supplies active-network state. Track `Page.downloadWillBegin`/`Page.downloadProgress` when Chrome emits them, without changing download behavior. Do not persist URLs, headers, bodies, field values, or media names in lifecycle logs.

**Step 4: Verify the pure tests and existing diagnostics integration on mac-mini**

Expected: the new unit tests pass and the detached monitor still retains console, frame, request-failure, and target-loss evidence.

### Task 4: Add conservative periodic reaping to each lane monitor

**Files:**
- Modify: `lib/lane-monitor.js`
- Modify: `lib/config.js`
- Create: `tests/integration/lane-reclamation.test.js`
- Modify: `scripts/run-integration-files.mjs` only if it has an explicit file allowlist

**Step 1: Write the end-to-end integration test**

Use an isolated runtime and disposable session. Set short test-only values through:

```text
WEB_PLANE_LANE_TTL_MS
WEB_PLANE_REAP_INTERVAL_MS
```

Prove incrementally that:

1. a clean hidden idle lane is closed, its mapping disappears, and a sibling tab survives;
2. a command refreshes the lease;
3. `keep` protects a lane until `unkeep`;
4. typed but unsubmitted input protects a lane;
5. playing media protects a lane;
6. a slow in-flight response protects a lane;
7. a page with a `beforeunload` handler is kept before any close is attempted;
8. showing the session protects every lane until it is hidden again.

Write timestamped per-step results to `logs/issue32/integration/run.jsonl`; cleanup closes only the disposable session.

**Step 2: Implement the monitor sweep**

Defaults:

```js
LANE_TTL_MS = 24 * 60 * 60 * 1000
REAP_INTERVAL_MS = 60 * 60 * 1000
```

At each interval, ignore leases below the threshold without logging. For an old lane, acquire the profile lock, re-read state, run the visibility and page-safety checks (including a CDP listener inspection for `beforeunload`), then either:

- append `lane-reap-skipped` with lane, age, and a named reason; or
- call bounded `Page.close`, dismiss any `beforeunload` dialog that races the prior inspection, verify target disappearance, append `lane-reaped`, forget the lane mapping, and stop that monitor.

The safety check and close are distinct calls under one lock. If any check throws or times out, leave the page open.

**Step 3: Run the integration file alone on mac-mini**

Expected: PASS with all eight per-step records in the JSONL log.

### Task 5: Expose keep/unkeep and make normal completion mandatory in the browser skills

**Files:**
- Modify: `lib/lane-commands.js`
- Modify: `lib/cdp.js`
- Modify: `bin/web-plane.js`
- Modify: `tests/unit/lane-commands.test.js`
- Modify: `tests/unit/cli.test.js`
- Modify: `SKILL.md`
- Modify: `plugins/browser/skills/browser/SKILL.md`
- Modify: `README.md`

**Step 1: Write failing CLI tests**

Prove that `lane <lane> keep` and `lane <lane> unkeep` mutate state without reaching agent-browser or starting/recovering Chrome, and that help names the 24-hour backstop and environment overrides.

**Step 2: Implement the commands**

Print the lane name and resulting state. Keep/unkeep must work on a recorded lane even when its browser is temporarily down. Missing lanes fail with the existing attach guidance.

**Step 3: Update durable instructions**

Add one task-lifecycle boundary: a lane belongs to the task that attached it and must be closed before the task returns, including error paths. `keep` is reserved for an explicitly deliberate long-lived page; `unkeep` restores automatic cleanup. State the automatic backstop as behavior, not as a substitute for normal cleanup.

Run a cold read and the required instruction review for each cross-project browser skill before saving the final wording.

### Task 6: Release, full mac-mini verification, and deployment

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `plugins/browser/.claude-plugin/plugin.json`

**Step 1: Bump the package/plugin version to 0.3.9**

Do not bump `RUNTIME_VERSION`: this change is JS/package behavior and durable instructions; it does not change the Node↔Playwright-patch↔dylib state protocol.

**Step 2: Run the mac-mini pre-flight**

- confirm the screen is unlocked;
- confirm the isolated runtime/log directories;
- run the new reclamation integration test alone;
- confirm a clean disposable lane closes and a protected disposable lane remains.

**Step 3: Run full verification on mac-mini**

```bash
npm run check
npm run test:unit
npm run test:doctor
npm run test:integration
npm run test:mutation
```

Retain timestamped output under `logs/issue32/full-*`. No dynamic test runs on the MacBook.

**Step 4: Privacy audit, commit, push, deploy**

Audit the public diff for credentials, private URLs, cookies, field values, and local paths. Commit and push `main`, install the immutable GitHub revision on mac-mini, rebuild the runtime only after confirming no live production lanes, run `web-plane doctor`, and execute an installed-package lane-reclamation smoke in an isolated profile.

**Step 5: Finish repository state**

Close issue #32 as completed without posting a comment. Confirm GitHub has no remaining open issues and update the existing omem project/deployment records with the verified state.
