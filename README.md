# web-plane

The web control plane for AI agents.

Browser automation CLIs like [agent-browser](https://github.com/vercel-labs/agent-browser) download a special "Chrome for Testing" binary. That binary ships with `navigator.webdriver=true` and other automation markers. Cloudflare spots it immediately:

```
$ agent-browser open https://chatgpt.com
✓ Just a moment...     ← Cloudflare challenge page
```

web-plane takes a different approach. It clones your real system Chrome via APFS copy-on-write, re-signs it for DYLD injection, and runs it in headed mode with zero visual flash. Websites can't distinguish it from you browsing normally, because the browser *is* your normal Chrome.

```
$ web-plane open https://chatgpt.com
Page Title: ChatGPT    ← logged in, ready to go
```

## How it works

1. **APFS clone** of `/Applications/Google Chrome.app` — copy-on-write, takes seconds, shares disk space with the original
2. **DYLD injection** hooks `NSWindow` methods at launch to suppress the window before the first frame renders
3. **SIGUSR signals** control visibility post-launch: `SIGUSR1` sets all windows transparent, `SIGUSR2` restores them
4. **Patched playwright-cli** orchestrates Chrome launch with the DYLD hook and handles CDP state transitions

The browser is headed (not headless), renders to a real GPU surface, and maintains persistent login sessions. Screenshots work even when the window is hidden.

## Install

Not published to npm — install straight from the repo:

```bash
npm install -g github:andylizf/web-plane
web-plane install
```

`web-plane install` clones Chrome, compiles the native DYLD hook, patches playwright-cli, and sets everything up under `~/.web-plane/`. Idempotent — re-run after Chrome updates. (A background Chrome update can re-sign the clone and break DYLD injection; the next hidden launch detects that and re-applies the ad-hoc signature automatically, so re-running `install` is only needed to pick up a new Chrome version.)

Requires: macOS, Google Chrome, Node.js >= 18, Xcode Command Line Tools.

## Usage

```bash
# Open a page (zero flash, Cloudflare-proof)
web-plane open https://chatgpt.com

# Named sessions persist login state
web-plane -s=research open https://chatgpt.com

# Interact via accessibility tree refs
web-plane -s=research snapshot          # get refs: e1, e2, e3...
web-plane -s=research click e3
web-plane -s=research fill e5 "query"
web-plane -s=research eval "document.title"

# Window control
web-plane hide                          # transparent, screenshots still work
web-plane show                          # visible again
web-plane toggle
web-plane status                        # PID, CDP port, visibility

# Close
web-plane -s=research close
```

All playwright-cli commands are supported. web-plane auto-injects `--headed`, `--profile`, and `--config` on `open`.

## vs agent-browser

|  | web-plane | agent-browser |
|--|-----------|--------------|
| Chrome | System Chrome (APFS clone) | Chrome for Testing |
| `webdriver` flag | No | Yes |
| Cloudflare | Passes | Blocked |
| Window | Zero-flash headed (DYLD hook) | Visible or headless |
| Login persistence | Per-session profiles | Manual state save/load |
| Hide/show | Built-in (`show`/`hide`/`toggle`) | Not available |
| Screenshot while hidden | Yes (alpha transparency) | N/A |
| Platform | macOS (Linux planned) | macOS, Linux, Windows |
| Runtime | Node.js + playwright-cli | Rust binary |

## Use *with* agent-browser

The table frames them as alternatives, but they compose cleanly: let
agent-browser do the operating and web-plane do the disguising. `web-plane cdp`
starts (or reuses) a hidden stealth session and prints its CDP port; agent-browser
attaches over CDP and drives it — `webdriver=false` and all — without a window
stealing focus.

```bash
web-plane cdp                     # prints: Session / CDP port / Attach: agent-browser connect <port>
agent-browser connect <port>      # drive with agent-browser from here on
agent-browser goto https://chatgpt.com
web-plane hide                    # invisible; agent-browser keeps driving
```

web-plane keeps `show`/`hide`/`status`/`close`; agent-browser owns page
operations. The CDP port is auto-assigned — read it from `cdp` output rather than
hardcoding. See [`SKILL.md`](SKILL.md) for the full agent-facing guide, and
`scripts/smoke.sh` to verify the chain end to end.

## Architecture

```
web-plane CLI (Node.js)
    │
    ├── install     → APFS clone Chrome + re-sign + compile DYLD hook + patch playwright-cli
    │
    ├── open <url>  → playwright-cli with DYLD injection + real Chrome
    │
    ├── show/hide   → SIGUSR signals to Chrome process + CDP window positioning
    │
    └── *           → proxy to playwright-cli (snapshot, click, fill, eval, screenshot, ...)
```

Runtime files live in `~/.web-plane/`:

```
~/.web-plane/
├── Chrome.app/                  APFS clone (re-signed for DYLD)
├── playwright-cli/              Local install (patched, not global)
├── window_suppress.dylib        DYLD hook for zero-flash launch
├── profiles/<session>/          Persistent browser profiles
└── cli.config.json              Launch config
```

## License

MIT
