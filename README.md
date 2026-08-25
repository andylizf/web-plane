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

The npm registry name is a security placeholder, so install the package copy
from GitHub:

```bash
npm install -g github:andylizf/web-plane
web-plane install
web-plane doctor
```

Do not use `npm link` for the production command. It makes the executable follow
the current git checkout, so switching branches can mix incompatible JS, patch,
and dylib revisions. See [`CLAUDE.md`](CLAUDE.md) for the isolated development
workflow.

`web-plane install` clones Chrome, rebuilds a locked playwright-cli with the
checked-in patches, compiles the native tools, and records their shared runtime
protocol under `~/.web-plane/`. It requires web-plane sessions to be closed but
does not touch profiles or login state. Re-run it after upgrading the package or
when `doctor` reports an old Chrome clone. A background Chrome update that only
changes the clone's signature is healed automatically on the next launch.

agent-browser 0.34.0 is a pinned npm dependency of web-plane; it is installed by
the first command and checked by `doctor`. Do not install another copy and do
not run `agent-browser install`: web-plane already provides Chrome over CDP.

Requires: macOS, Google Chrome, Node.js >= 24, Xcode Command Line Tools.

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

# Native Save/Open panel control (JSON responses)
web-plane -s=research ui status
web-plane -s=research panel status
web-plane -s=research panel accept --path /Users/me/Downloads/report.pdf
web-plane -s=research panel cancel

# Close
web-plane -s=research close
```

All playwright-cli commands are supported. web-plane auto-injects `--headed`, `--profile`, and `--config` on `open`. An explicit `--profile <path>` is passed through to Playwright commands; web-plane's own `cdp`, `attach`, `status`, and `close` commands use the session-owned profile under `~/.web-plane/profiles/<session>`, selected with `-s=<name>`.

JavaScript `alert`, `confirm`, `prompt`, and `beforeunload` dialogs belong to
Playwright and should be handled there. File uploads should use
`setInputFiles`. The `panel` command is intentionally narrower: it controls only
real AppKit `NSSavePanel`/`NSOpenPanel` windows owned by managed Chrome. It does
not click Touch ID, Keychain, password, privacy-consent, or arbitrary desktop
UI. `panel accept` refuses relative paths and existing Save targets, and the
caller must still verify that the resulting download or open operation finished.
While a managed session is hidden, Save/Open presentation is held so the agent
can answer without showing UI or taking focus. Running `show` releases a pending
panel for normal human interaction.

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
web-plane -s=work attach --as task1 https://chatgpt.com  # waits for network idle
web-plane lane task1 snapshot
web-plane lane task1 type e3 "replacement"                # replace, never append
web-plane lane task1 type e3 " suffix" --append           # append explicitly
web-plane lane task1 find role button click --name "Save" # fresh semantic ref
web-plane lane task1 click e4                              # centers/retries if covered
web-plane lane task1 click e4 --force                      # deliberate trusted click
web-plane lane task1 close                                 # this tab only
web-plane -s=work hide            # invisible; the lane keeps driving
```

`attach` starts or reuses the hidden browser, opens a labelled tab, and gives its
agent-browser session a strict persistent target binding. Agents that share one
login use the same `-s` profile and different `--as` lanes. agent-browser owns
that binding; `web-plane lane` activates the already-bound target through CDP so
Chrome-owned UI is observable, without reselecting it through agent-browser or
invalidating refs from the preceding snapshot. The wrapper checks for blocking
browser/native UI before and after each command. Page input fails closed;
inspection and navigation remain available for diagnosis and recovery. Lanes
on one profile keep independent pinned targets, while this command boundary is
serialized because Chrome has only one selected tab.

`attach`, `open`, `goto`, and `navigate` wait for network idle for up to 15
seconds by default. Override that with `--wait-for load`, `--wait-for
domcontentloaded`, `--wait-for <selector>`, `--timeout <ms>`, or `--no-wait`.
Use `web-plane lane <lane> wait ...` for a readiness condition between actions.

Lane input is intentionally safer than the upstream shorthand. `type` replaces
the current value and reports only the before/after lengths; `--append` opts
into keystroke append semantics, and `clear <selector>` empties a field without
hand-written key loops. `find role ... --name ...` takes a fresh snapshot and
resolves a fresh ref, including elements exposed from iframes. `key` reports the
deepest focused frame/element before dispatching through CDP. For DOM work that
must span frames, `eval --all-frames <expression>` returns one value or error per
frame.

When a large canvas owns the viewport, `snapshot` prints a hint to use
`screenshot`; this is the fallback for Sheets, Figma, maps, charts, and other
content absent from the accessibility tree.

`web-plane lane <lane> errors` reads uncaught exceptions retained by the lane's
persistent driver, including rejected promises and timer callbacks that failed
after an earlier `eval` had already returned successfully.

Each attached lane also has a detached CDP observer. `web-plane lane <lane>
netlog --failed` shows HTTP failures and `Network.loadingFailed.errorText`;
console errors, uncaught page errors, and failed requests that appear after an
input command are warned immediately. Evidence is append-only, mode 0600, and
keeps metadata only—never headers or request/response bodies—under
`~/.web-plane/logs/sessions/<profile>/`. Chrome stdout/stderr and timestamped
session lifecycle events live beside it, and browser-death errors print their
exact paths.

`web-plane -s=work ui status` reports blocking UI without displaying it. A
browser-owned child modal such as WebAuthn is distinguished structurally from
unparented Recover/download bubbles, without matching localized titles. The
lane whose command exposed a tab-modal blocker is recorded, so other lanes in
the same browser remain usable. The response lists the available choices;
`show` is an explicit agent decision, not a side effect of detection.

A managed Workspace sign-in can make Chrome create another inner profile inside
one `-s` user-data directory. `web-plane profiles` marks this as `SPLIT`. While
both inner profiles have live pages, `show`, `cdp`, and `attach` refuse rather
than activating or attaching to an arbitrary identity; close the extra profile
window or restart the session before retrying.

For providers where Chrome records account labels, `web-plane profiles`
annotates login hosts with the email identities it can see. A known
multi-account host with no label is marked `identity unknown`; a listed host is
still evidence of some session, not proof that the required account is present.

Before an idle managed profile launches, web-plane makes a verified private
copy of Chrome's Session/Tabs files, enables Chrome's last-session startup
setting, and launches with Chrome's own `--restore-last-session` path. If a
browser dies, the next `web-plane lane` command restores Chrome's saved tabs and
rebinds the lane only when its recorded URL identifies one restored target. The
command exits after rebinding; take a fresh snapshot and run the intended action
again. This prevents a click, form submission, or upload from being replayed.

Chrome owns the recovered tab, URL, and navigation history. Recent form values,
scroll position, and in-memory application state may not have reached Chrome's
session file before a hard crash and are not guaranteed. If two restored tabs
are indistinguishable, web-plane refuses to choose and requires an explicit
`attach`. If the restored session kills Chrome again, web-plane retains its
backup under `~/.web-plane/backups/chrome-sessions/`, quarantines the live
restore files, and makes one clean launch instead of looping. Existing browser
logs are rotated rather than overwritten.

For a manual connection, run `web-plane -s=work cdp` and use the exact
`web-plane agent-browser --session work --pin-tab connect <port>` command it
prints. Both flags matter: `--session` isolates the daemon and `--pin-tab`
prevents it from adopting another session's target. The wrapper selects
web-plane's pinned dependency even if an older `agent-browser` exists on PATH.

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
    ├── ui/panel    → typed requests to the injected AppKit bridge
    │
    ├── lane        → pinned agent-browser target + pre/post UI gate
    │
    └── *           → proxy to playwright-cli (snapshot, click, fill, eval, screenshot, ...)
```

Runtime files live in `~/.web-plane/`:

```
~/.web-plane/
├── Chrome.app/                  APFS clone (re-signed for DYLD)
├── playwright-cli/              Locked, freshly patched local install
├── window_suppress.dylib        DYLD hook for zero-flash launch
├── runtime-version              Shared JS/patch/dylib protocol version
├── profiles/<session>/          Persistent browser profiles
├── logs/install-*.log           Durable install logs
├── logs/sessions/<session>/     Browser, lifecycle, and lane event evidence
├── lanes/<sha256>.json          Private lane-to-restored-tab recovery state
├── backups/chrome-sessions/     Verified restore backups and quarantines
├── backups/runtime-*/           Previous generated runtime
└── cli.config.json              Launch config
```

## Tests

Everything here manipulates state it cannot directly observe — the window
server, an injected dylib, a patched third-party tree — so the tests assert
observed effects and never that a command returned.

```bash
npm run check             # every JS file parses (commands are imported lazily)
npm run test:unit         # no display needed: session/profile resolution, lane
                          # safety, and show's verification rules fed synthetic
                          # window-server states
npm run test:doctor       # doctor against an install broken one layer at a time
npm run test:integration  # real cloned Chrome, one file at a time with durable
                          # JSONL results, per-file logs, and resume checkpoints
npm run test:mutation     # puts known bugs back and demands the suite go red
```

`test:integration` needs an **unlocked** Mac with a live window server: while the
screen is locked macOS composites nothing, so a window that was shown correctly
and a window that never appeared look identical. It refuses to run in that state
rather than passing without proving anything — and rather than skipping, which
would read as a green tick.

Set `WEB_PLANE_INTEGRATION_RUN_DIR` to a project-local directory to resume a
specific run. Successful per-file checkpoints are skipped; failed or interrupted
files are rerun, and each attempt gets a new log instead of overwriting evidence.

`test:integration` also covers focus: a hidden launch must not take the
foreground, hiding must preserve browser coordinates while remaining
click-through, native panels must get a temporary interactive foreground, and
the private AppKit selector the focus fix depends on must still exist. For a
quick manual check outside the suite:

```bash
./tests/focus-steal.sh <label>   # does a hidden launch take the foreground?
```

Both are judged by `tests/native/focusmon.m`, an observer that listens for
activation events, polls the frontmost app, and records each app's actual
activation policy. Run the shell one at least three times: focus theft is a
race, and a single green run has already been wrong twice. A dead browser also
produces a perfectly clean focus log, so liveness is part of the verdict — no
live process reports `INVALID` rather than `CLEAN`.

`test:integration` runs serially (`--test-concurrency=1`): these tests own the
screen, the foreground and the Dock, so two files running at once observe each
other's browsers and fail for the wrong reasons.

`tests/tools/trace-window.mjs` walks one session through launch → hide → show and
prints what Chrome, CoreGraphics and the Accessibility API each say about the
window at every step. It is the fastest way into any "but it says it worked" bug.

## License

MIT
