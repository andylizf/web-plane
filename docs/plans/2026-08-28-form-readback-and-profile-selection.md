# Form Read-Back and Explicit Chrome Profile Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make every field write prove the exact resulting value, expose form state through snapshot refs, and make native Chrome restore deterministic and bounded when a user-data-dir contains multiple inner profiles.

**Architecture:** Keep agent-browser as the lane driver and Chrome as the session-restoration owner. Web-plane captures structured `get value` results after every field write, compares them with the intended value, and enriches snapshots through the refs already assigned by agent-browser; password values are never printed. Chrome is always launched into the managed `Default` inner profile, and every synchronous launcher boundary has a phase-specific timeout and error record.

**Tech Stack:** Node.js 24 ESM, node:test, agent-browser 0.34.0, playwright-cli 0.1.1, Chrome CDP, macOS integration tests on mac-mini.

---

### Task 1: Exact field read-back primitives

**Files:**
- Modify: `lib/page-diagnostics.js`
- Test: `tests/unit/page-diagnostics.test.js`

**Step 1: Write failing tests**

Cover structured value parsing, JSON-safe normal-field output, password-length output, exact replacement/clear verification, append verification, and failed or mismatched reads.

**Step 2: Run the tests on mac-mini and verify they fail**

Run: `node --test tests/unit/page-diagnostics.test.js`

Expected: FAIL because the value parser and exact verification formatter do not exist.

**Step 3: Implement the minimal pure functions**

Parse the complete `get value --json` response instead of immediately reducing it to a length. Return a structured verification result containing the actual value, expected value, match status, safe display form, and a stable failure message.

**Step 4: Run the test on mac-mini and verify it passes**

Run: `node --test tests/unit/page-diagnostics.test.js`

Expected: PASS.

### Task 2: Read back every lane field write

**Files:**
- Modify: `lib/cdp.js`
- Test: `tests/integration/lane-page-behavior.test.js`

**Step 1: Write failing behavior tests**

Require `fill`, replacement `type`, append `type`, `clear`, and semantic `find ... fill` to read the same ref after dispatch. Normal fields must report the actual JSON-escaped value; password fields must report only their length. A missing read or mismatched value must return a non-zero status.

**Step 2: Run the focused tests on mac-mini and verify they fail**

Run: `node --test tests/integration/lane-page-behavior.test.js`

Expected: FAIL because current commands compare only lengths.

**Step 3: Implement exact post-write verification**

Read `get value <ref>` after every write. For replacement and clear, compare with the supplied target exactly. For append, compare with the concatenation of the pre-write and appended values. Read the field's `type` attribute before printing so password values remain redacted. Preserve the upstream command output, then print one unambiguous verified-value line.

**Step 4: Run the focused tests on mac-mini and verify they pass**

Run: `node --test tests/integration/lane-page-behavior.test.js`

Expected: PASS.

### Task 3: Form state in snapshots

**Files:**
- Modify: `lib/cdp.js`
- Modify: `lib/page-diagnostics.js`
- Test: `tests/unit/page-diagnostics.test.js`
- Test: `tests/integration/lane-page-behavior.test.js`

**Step 1: Write failing snapshot tests**

Create populated, empty, password, checkbox, and combobox controls. Assert that a single `lane snapshot` reports explicit state using its existing refs, including `value=""` for empty controls and a length-only password representation.

**Step 2: Run the focused integration test on mac-mini and verify it fails**

Run: `node --test tests/integration/lane-page-behavior.test.js`

Expected: FAIL because snapshot is currently an unmodified agent-browser pass-through.

**Step 3: Enrich snapshot output internally**

Capture the upstream snapshot, parse form-control refs, and query their state inside the same web-plane command. Do not require CSS selectors or an additional caller round trip. Preserve upstream ordering and avoid duplicating values agent-browser already emitted.

**Step 4: Run the focused integration test on mac-mini and verify it passes**

Run: `node --test tests/integration/lane-page-behavior.test.js`

Expected: PASS.

### Task 4: Deterministic native session restore

**Files:**
- Modify: `lib/config.js`
- Modify: `lib/profile-runtime.js`
- Modify: `lib/commands.js`
- Modify: `lib/agent-browser.js`
- Modify: `lib/health.js`
- Test: `tests/unit/profile-runtime.test.js`
- Test: `tests/doctor/doctor.test.js`
- Test: `tests/integration/lane-recovery.test.js`

**Step 1: Write failing unit and doctor tests**

Require the managed launch config to include exactly one `--profile-directory=Default`, require launch/connect timeout errors to name the phase, and require doctor to surface any on-disk `Default + Profile N` split without declaring the runtime healthy and silent.

**Step 2: Run the focused tests on mac-mini and verify they fail**

Run: `node --test tests/unit/profile-runtime.test.js tests/doctor/doctor.test.js`

Expected: FAIL because profile selection, timeout reporting, and doctor visibility are absent.

**Step 3: Implement deterministic selection and bounded subprocesses**

Always select `Default`, which is already the profile whose sessions and preferences web-plane preserves. Add explicit timeouts to Playwright launch and agent-browser attach/connect boundaries, and record the phase and timeout in the session event log before returning an error. Add a doctor row that identifies split sessions and the selected inner profile.

**Step 4: Run the focused tests on mac-mini and verify they pass**

Run: `node --test tests/unit/profile-runtime.test.js tests/doctor/doctor.test.js`

Expected: PASS.

### Task 5: Full verification and deployment

**Files:**
- Modify: `README.md`
- Modify: `plugins/browser/skills/browser/SKILL.md`
- Modify: `plugins/browser/skills/browser/references/stealth.md`
- Modify: `package.json`

**Step 1: Update durable behavior documentation**

Document exact write verification, password redaction, form-state snapshots, explicit `Default` selection, and bounded attach failures. Bump the package patch version because the behavior and distributed package change without changing the native runtime protocol.

**Step 2: Run the complete required suite on mac-mini**

Run: `npm run check && npm run test:unit && npm run test:doctor && npm run test:integration && npm run test:mutation`

Expected: all commands exit 0. Logs must be written under the project-local mac-mini checkout and retained for the deployment report.

**Step 3: Commit and push**

Run the public-repository privacy audit, then commit the implementation in reviewable units and push `main`.

**Step 4: Deploy an immutable package copy on mac-mini**

Run: `npm install -g github:andylizf/web-plane#<verified-commit> && web-plane install && web-plane doctor`

Expected: the installed version matches the new package version, runtime checks pass, and doctor reports explicit `Default` selection.

**Step 5: Run production smoke tests on mac-mini**

Use project-local disposable fixtures, never the real profile. Verify a user-data-dir containing `Default` and `Profile 1` restores the `Default` tab, attach completes within its bound, every field write returns the actual safe value, and snapshot distinguishes populated from empty fields. Retain timestamped command output under `logs/`.
