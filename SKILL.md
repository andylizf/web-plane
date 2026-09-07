---
name: stealth-browser
description: >-
  Drive a browser on macOS undetectably and without a visible window stealing
  focus. Use when a task needs real-Chrome browsing that passes bot detection
  (Cloudflare/logged-in sites) driven by agent-browser: web-plane provides a
  cloned real Chrome (navigator.webdriver=false) with a zero-flash hidden
  window; agent-browser connects over CDP and does the operations.
---

# Stealth browser: web-plane + agent-browser

web-plane and [agent-browser](https://github.com/vercel-labs/agent-browser) are
complementary, not competing:

- **agent-browser** = the operation layer (fast daemon, ref-based snapshots, rich
  commands). Its default engine is Chrome for Testing — `navigator.webdriver=true`,
  detectable.
- **web-plane** = the stealth kernel (a cloned, re-signed real Chrome →
  `webdriver=false`, real UA, Cloudflare-proof) with a macOS "zero-flash" hidden
  window that does not take focus on launch (`docs/window-and-focus.md`).

Point agent-browser at web-plane's hidden Chrome over CDP and you get
agent-browser's ergonomics with web-plane's undetectability, invisibly.

## When to use

- You need to drive a site that blocks automation (Cloudflare, bot checks) or a
  logged-in session, on macOS.
- You want the browser to work in the background without a window grabbing focus.
- You're on macOS. (web-plane is macOS-only.)

## Install (one-time)

```bash
npm install -g github:andylizf/web-plane
web-plane install
web-plane doctor
```

The CLI is installed as a package copy, never with `npm link`; otherwise branch
switches can change production code underneath the installed runtime.
`web-plane install` clones your system Chrome (APFS copy-on-write), compiles the
DYLD window-suppression hook, and rebuilds a locked local playwright-cli — all
under `~/.web-plane/`. Re-run it after a package upgrade or when `doctor` reports
that the Chrome clone drifted. Requires macOS, Google Chrome, Node.js >= 24,
Xcode Command Line Tools. agent-browser 0.34.0 is installed as web-plane's
pinned npm dependency; do not install another copy.
No `agent-browser install` step is needed: it drives web-plane's managed Chrome
over CDP instead of downloading another browser.

## Use

1. Start or reuse the stealth browser, open a labelled tab, and attach an
   isolated agent-browser lane:

   ```bash
   web-plane -s=main attach --as task1 https://example.com
   ```

   `-s` selects a managed `--user-data-dir` that web-plane expects to carry one
   login identity in one Chrome browser instance. `--as` selects the lane: one
   agent-browser daemon and one labelled tab. Agents that share an identity use
   the same profile and different lanes.

2. Drive through the lane. agent-browser keeps the lane bound to its own CDP
   target; the wrapper activates that target for Chrome-owned UI and adds
   blocking-UI checks without disturbing snapshot refs:

   ```bash
   web-plane lane task1 snapshot
   web-plane lane task1 type e3 "replacement"             # replaces by default
   web-plane lane task1 type e3 " suffix" --append        # explicit append
   web-plane lane task1 clear e3
   web-plane lane task1 find role button click --name Save # fresh semantic ref
   web-plane lane task1 click e4                           # auto-centers once
   web-plane lane task1 click e4 --force                   # deliberate override
   ```

   `attach` defaults to waiting for load, and lane navigation defaults to network
   idle; both use a 15-second timeout.
   Use `--wait-for <load|domcontentloaded|networkidle|selector>`, `--timeout
   <ms>`, or `--no-wait` when the page needs a different contract. `type` reads
   the same field back: ordinary values are printed, while passwords are compared
   internally and reported by length only.

3. Confirm you're stealthy (optional):

   ```bash
   web-plane lane task1 eval "navigator.webdriver"   # => false
   ```

For a manual CDP connection, run `web-plane -s=main cdp` and use the exact
`web-plane agent-browser --session main --pin-tab connect <port>` command it
prints. Do not omit either flag: they isolate the daemon and its target binding.

The manual agent-browser command above does not acquire web-plane's command lock;
reserve it for solitary diagnostics, not shared-lane driving.

One lane owns one tab and belongs to the task that attached it. Unless the user
explicitly wants the page to outlive the task, arrange a finally-equivalent
cleanup as soon as attach succeeds so `web-plane lane task1 close` runs before
the task returns on success, error, or cooperative cancellation. It closes that
tab and stops its agent-browser daemon. Use another lane when the task needs
another page.
Lanes sharing one profile keep independent pinned targets, and callers may
submit commands concurrently. web-plane `lane`, `attach`, and crash-recovery
calls that drive one profile queue for a critical section: target activation,
native UI checks, and the command itself. Activation changes which tab and
window Chrome treats as active, and Chrome-owned UI is tied to that active
target, so those steps stay atomic.
`attach` holds the lock while connecting, selecting or creating a tab, and
navigating, then releases it before waiting for readiness. Crash recovery and
ordinary lane commands retain the lock through their commands. Other profiles, page scripts, page network
work, and local `netlog` reads continue. An ordinary lane command waits up to 30
seconds before returning `LANE_BUSY`; attach and recovery use the same default
timeout but report their own reserve/recovery failure. The reaper waits one
second and retries later.
This web-plane command lock is separate from Chrome's `ProcessSingleton`, which
governs browser-instance ownership and forwards later launches for the same
`--user-data-dir`; it does not serialize web-plane commands or native UI checks.

If a page deliberately outlives its task, leave it open without a special keep
state. Its detached monitor enters forced reclamation 24 hours after the last
lane command. Once it acquires the same-profile critical section and confirms
the target mapping, it directly closes the target regardless of visibility,
unsaved input, media, `beforeunload`, requests, or downloads; then it stops that
lane's agent-browser daemon, removes the lane mapping, and exits. Lock contention
or a failed close/driver cleanup is logged and retried rather than reported as
success. Any same-profile critical-section holder can delay an attempt; any
command through this lane renews its deadline. If the monitor process itself is
killed, this backstop resumes only when attach or recovery starts it again. The
backstop does not replace task cleanup.

`web-plane install` enables Chrome Maximum Memory Saver for every existing
managed profile, and each later launch enforces it again. Chrome may deactivate
a background tab and reload it on next access; it does not close the lane or
replace the hard idle timeout.

If an `eval` starts asynchronous work and returns before that work fails, read
the lane's persistent error buffer instead of treating the later empty result as
success:

```bash
web-plane lane task1 errors
web-plane lane task1 netlog --failed
```

The detached lane observer retains console errors, uncaught exceptions, HTTP
failures, and CDP failure reasons under `~/.web-plane/logs/sessions/<profile>/`.
Input commands warn when new failures arrive. The logs contain request metadata,
not headers or bodies.

If Chrome dies, run the next lane command normally. web-plane first backs up
Chrome's Session/Tabs files, lets Chrome restore its saved tabs, and rebinds the
lane only to a unique recorded-URL match. A successful recovery stops before
executing that command: take a fresh snapshot, then run the intended action
again. Never treat recovery as proof that a recent form value, scroll position,
or in-memory application state survived. If matching is ambiguous, follow the
reported explicit `attach` command. If the restored page kills Chrome again,
web-plane quarantines the verified restore set and makes one clean launch.

Use `web-plane lane task1 eval --all-frames '<expression>'` when the value may
live inside an iframe. `key` reports the deepest focused element before sending
the chord. If `snapshot` says the page appears canvas-rendered, use `screenshot`
and read the image; the DOM/a11y tree cannot expose canvas pixels.

`web-plane profiles` marks a user-data directory as `SPLIT` if Chrome created
multiple inner profiles such as `Default` and `Profile 1`. When more than one
inner profile has live pages, `show`, `cdp`, and `attach` refuse rather than
choosing an identity. Close the extra profile window or restart the session.
When Chrome records account emails, Google login hosts are annotated with those
identities. A bare host or `identity unknown` never proves the account you need
is present.

## Hide / show

web-plane owns window visibility; agent-browser keeps driving either way:

```bash
web-plane -s=work hide     # window invisible, CDP control unaffected
web-plane -s=work show
web-plane -s=work status   # PID, CDP port, visibility
web-plane -s=work close
```

## Dialog and native panel routing

Start with the unified read-only status when page input stops taking effect:

```bash
web-plane -s=work ui status
```

`web-plane lane` checks this state before and after page commands. If it returns
`UI_BLOCKED`, do not retry the same input. Choose from the blocker actions:
wait, navigate to abort the request, handle a typed panel, or explicitly run
`web-plane -s=work show` when a human should take over. Detection never shows a
window by itself.

- Handle JavaScript `alert`, `confirm`, `prompt`, and `beforeunload` through the
  browser driver's dialog API.
- Upload files with `setInputFiles` or the driver's file-chooser event; do not
  operate the visible Open panel for an HTML file input.
- For a real macOS Save/Open panel owned by managed Chrome, use:

  ```bash
  web-plane -s=work panel status
  web-plane -s=work panel accept --path /absolute/path
  web-plane -s=work panel cancel
  ```

  Responses are JSON. After `accept`, verify the expected file or browser event;
  dismissal alone is not completion. Touch ID, Keychain, passwords, privacy
  consent, and other protected system UI are not generically clicked. The agent
  decides whether to wait, abort the owning request, or explicitly use
  `web-plane -s=work show` for human interaction. Hidden sessions hold Save/Open
  presentation until the agent handles it or chooses that handoff.

## Caveats

- **macOS only.**
- Re-run `web-plane install` after package upgrades or when `web-plane doctor`
  reports that the clone no longer tracks system Chrome.
- CAPTCHAs / MFA still need a human — stealth avoids being *flagged*, it does not
  solve challenges.

## Verify the whole chain

`scripts/smoke.sh` runs the full manual path with an isolated agent-browser
session (cdp → connect → webdriver=false → navigate → hide → still drivable →
close) and prints PASS/FAIL.
