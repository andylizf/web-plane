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
3. **Activation suppression** stops AppKit's window-restoration pass from pulling the app to the foreground — a separate problem from the window, and one no NSWindow hook can solve
4. **SIGUSR signals** control visibility post-launch: `SIGUSR1` sets all windows transparent, `SIGUSR2` restores them
5. **Patched playwright-cli** orchestrates Chrome launch with the DYLD hook and handles CDP state transitions

The browser is headed (not headless), renders to a real GPU surface, and maintains persistent login sessions. Screenshots work even when the window is hidden.

No window is ever visible and a launch does not take your keyboard — but those are two different mechanisms, and the second one was broken for a long time. macOS grants the foreground to an *application*, not a window, so a fully cloaked browser could still steal focus for six seconds. The cause turned out to be AppKit's own "Resume" window restoration activating the app, not anything Chromium did. See [`docs/window-and-focus.md`](docs/window-and-focus.md) for the trace, the measurements, and the several fixes that looked right and were not.

## Install

Not published to npm — install straight from the repo:

```bash
npm install -g github:andylizf/web-plane
web-plane install
```

If your npm doesn't handle git installs cleanly (some restricted / Nix-managed
setups leave a dangling link), clone and link instead — same result:

```bash
git clone https://github.com/andylizf/web-plane ~/Projects/web-plane
cd ~/Projects/web-plane && npm link
web-plane install
```

`web-plane install` clones Chrome, compiles the native DYLD hook, patches playwright-cli, and sets everything up under `~/.web-plane/`. Idempotent — re-run after Chrome updates. (A background Chrome update can re-sign the clone and break DYLD injection; the next hidden launch detects that and re-applies the ad-hoc signature automatically, so re-running `install` is only needed to pick up a new Chrome version.)

Requires: macOS, Google Chrome, Node.js >= 22, Xcode Command Line Tools.

### Screen Time will break this, silently

If Screen Time has an app limit covering Google Chrome, **add Chrome to Always
Allowed** (System Settings → Screen Time → Always Allowed). Otherwise every
session breaks the moment that limit is reached, and it breaks in the worst
possible way: quietly.

The clone is a copy of your Chrome, so it carries the same bundle identifier
(`com.google.Chrome`). Screen Time matches on that identifier, which means a
limit you set for your own browsing also applies to every browser your
automation drives — and there is no separate limit to exempt.

What it looks like when it happens:

- `show` fails, or reports success while nothing appears on screen
- the window has the right size and position and is completely invisible
- nothing in the logs mentions Screen Time

Because the block is enforced at the window server, not inside the process. The
same window, read at the same instant from both sides:

```
AppKit (in-process):    alpha 1.00   visible=1   frame 100,82  1280x800
Window server:          alpha 0      onscreen=false            1280x800
```

The process sets alpha 1 and genuinely holds alpha 1; the compositor draws
nothing. No amount of retrying from inside Chrome can win that, which is why
web-plane cannot work around it and does not try.

To confirm it is this and not a web-plane bug, look for the lockout panel macOS
injects into the process — its class name is unmistakable:

```bash
web-plane -s=<session> show          # then, if the screen stayed blank:
screencapture -x /tmp/screen.png     # a page screenshot cannot show it; this can
```

A `NSLockoutUIOverlayWindow` sized exactly like the browser window is Screen
Time. Note it is also *drawn over* the browser window, so with the window hidden
the notice explaining the blankness is hidden along with it.

This matters most for unattended automation. A scheduled job that drives a
browser — a login that refreshes a VPN cookie, a nightly scrape — will start
failing at whatever hour the limit trips, log only that it could not open a
page, and recover on its own the next day. That is a hard failure to read from
the logs alone.

### The `browser` skill (Claude Code)

This repo is also a Claude Code **plugin marketplace**. The `browser` skill — which tells agents to reach for web-plane by default and routes across fast/cloak/cloud/computer-use — installs the canonical way, not by copying files:

```bash
claude plugin marketplace add andylizf/web-plane
claude plugin install browser@web-plane --scope user
```

Or interactively inside Claude Code: `/plugin marketplace add andylizf/web-plane` then `/plugin install browser@web-plane`. For a headless / cloud session, declare it in `~/.claude/settings.json` instead:

```json
{
  "extraKnownMarketplaces": {
    "web-plane": { "source": { "source": "github", "repo": "andylizf/web-plane" } }
  },
  "enabledPlugins": ["browser@web-plane"]
}
```

That's the whole procedure — a brand-new machine gets the CLI + runtime from the two commands above, and the skill from the plugin. Nothing is copied between machines.

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

## Tests

Everything here manipulates state it cannot directly observe — the window
server, an injected dylib, a patched third-party tree — so the tests assert
observed effects and never that a command returned.

```bash
npm run check             # every JS file parses (commands are imported lazily)
npm run test:unit         # no display needed: session/profile resolution, lane
                          # pinning, and show's verification rules fed synthetic
                          # window-server states
npm run test:doctor       # doctor against an install broken one layer at a time
npm run test:integration  # a real cloned Chrome: launch → hide → show → close,
                          # judged by CoreGraphics, not by web-plane's own report
npm run test:mutation     # puts known bugs back and demands the suite go red
```

`test:integration` needs an **unlocked** Mac with a live window server: while the
screen is locked macOS composites nothing, so a window that was shown correctly
and a window that never appeared look identical. It refuses to run in that state
rather than passing without proving anything — and rather than skipping, which
would read as a green tick.

`test:integration` also covers focus: a hidden launch must not take the
foreground, `show` must not leave a window parked offscreen, and the private
AppKit selector the focus fix depends on must still exist. For a quick manual
check outside the suite:

```bash
./tests/focus-steal.sh <label>   # does a hidden launch take the foreground?
```

Both are judged by `tests/native/focusmon.m`, an observer that listens for
activation events, polls the frontmost app, and records each app's actual
activation policy. Run the shell one at least three times: focus theft is a
race, and a single green run has already been wrong twice. A dead browser also
produces a perfectly clean focus log, so liveness is part of the verdict — no
live process reports `INVALID` rather than `CLEAN`.

Two cases in `hide-show.test.js` are known-red and predate this suite's current
state — one is structurally flaky (all seven share a browser and run in order),
one fails only on the CDP-minimize path. Both fail identically on an unpatched
dylib. See [`docs/window-and-focus.md`](docs/window-and-focus.md).

`tests/tools/trace-window.mjs` walks one session through launch → hide → show and
prints what Chrome, CoreGraphics and the Accessibility API each say about the
window at every step. It is the fastest way into any "but it says it worked" bug.

## License

MIT
