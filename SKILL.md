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

   `-s` selects the profile: one login identity and one Chrome process. `--as`
   selects the lane: one agent-browser daemon and one labelled tab. Agents that
   share an identity use the same profile and different lanes.

2. Drive through the lane. agent-browser keeps the lane bound to its own CDP
   target; the wrapper activates that target for Chrome-owned UI and adds
   blocking-UI checks without disturbing snapshot refs:

   ```bash
   web-plane lane task1 snapshot
   web-plane lane task1 click e3
   ```

3. Confirm you're stealthy (optional):

   ```bash
   web-plane lane task1 eval "navigator.webdriver"   # => false
   ```

For a manual CDP connection, run `web-plane -s=main cdp` and use the exact
`web-plane agent-browser --session main --pin-tab connect <port>` command it
prints. Do not omit either flag: they isolate the daemon and its target binding.

One lane owns one tab. Use another lane when the task needs another page.
Lanes sharing one profile keep independent pinned targets; web-plane briefly
serializes each command boundary because Chrome has only one selected tab.

If an `eval` starts asynchronous work and returns before that work fails, read
the lane's persistent error buffer instead of treating the later empty result as
success:

```bash
web-plane lane task1 errors
```

`web-plane profiles` marks a user-data directory as `SPLIT` if Chrome created
multiple inner profiles such as `Default` and `Profile 1`. When more than one
inner profile has live pages, `show`, `cdp`, and `attach` refuse rather than
choosing an identity. Close the extra profile window or restart the session.

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
