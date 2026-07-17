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
  window that never steals focus.

Point agent-browser at web-plane's hidden Chrome over CDP and you get
agent-browser's ergonomics with web-plane's undetectability, invisibly.

## When to use

- You need to drive a site that blocks automation (Cloudflare, bot checks) or a
  logged-in session, on macOS.
- You want the browser to work in the background without a window grabbing focus.
- You're on macOS. (web-plane is macOS-only.)

## Install (one-time)

```bash
npm install -g web-plane && web-plane install
npm install -g agent-browser && agent-browser install
```

`web-plane install` clones your system Chrome (APFS copy-on-write), compiles the
DYLD window-suppression hook, and patches a local playwright-cli — all under
`~/.web-plane/`. It is idempotent; re-run it after a Chrome update. Requires
macOS, Google Chrome, Node.js >= 18, Xcode Command Line Tools.

## Use

1. Start the stealth kernel and get its CDP port:

   ```bash
   web-plane cdp
   # Session:  default
   # CDP port: 50504
   # Attach:   agent-browser connect 50504
   ```

   The port is auto-assigned — read it from this output, don't hardcode. Use
   `-s=<name>` for a named, persistent session (its login state survives across
   runs): `web-plane -s=work cdp`.

2. Attach agent-browser and drive normally:

   ```bash
   agent-browser connect 50504
   agent-browser goto https://example.com
   agent-browser snapshot
   agent-browser click e3
   ```

3. Confirm you're stealthy (optional):

   ```bash
   agent-browser eval "navigator.webdriver"   # => false
   ```

## Selecting the right tab

Connecting to a session that already has tabs lands agent-browser on *some*
existing target, not necessarily the one you want. Pick explicitly:

```bash
agent-browser tab list
agent-browser tab 0
```

## Hide / show

web-plane owns window visibility; agent-browser keeps driving either way:

```bash
web-plane -s=work hide     # window invisible, CDP control unaffected
web-plane -s=work show
web-plane -s=work status   # PID, CDP port, visibility
web-plane -s=work close
```

## Caveats

- **macOS only.**
- Re-run `web-plane install` after Chrome updates (the clone must track your
  system Chrome version).
- CAPTCHAs / MFA still need a human — stealth avoids being *flagged*, it does not
  solve challenges.

## Verify the whole chain

`scripts/smoke.sh` runs the full path (cdp → connect → webdriver=false →
navigate → hide → still drivable → close) and prints PASS/FAIL.
