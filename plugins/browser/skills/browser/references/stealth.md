# stealth — web-plane + agent-browser

The default for anything real: a logged-in session or a bot-protected site, on macOS.
web-plane provides a cloned, re-signed real Chrome (`navigator.webdriver=false`, real UA,
Cloudflare-proof) with a zero-flash hidden window; agent-browser attaches over CDP and
does the operating. The hidden launch neither shows a window nor takes focus (see Caveats).

## Install (one-time)
```bash
npm install -g github:andylizf/web-plane
web-plane install
web-plane doctor
```
`web-plane install` clones your system Chrome (APFS copy-on-write), compiles the DYLD
window-suppression hook, and patches a local playwright-cli under `~/.web-plane/`. Idempotent,
and it verifies the patch actually landed instead of assuming. Requires macOS, Google Chrome,
Node ≥24, Xcode CLT. web-plane pins agent-browser 0.34.0 as an npm dependency because it
uses its persistent strict tab binding. No second agent-browser or Chrome install is needed.

## Drive
```bash
web-plane -s=main attach --as work https://example.com   # start/reuse + open + connect
web-plane lane work snapshot                             # refs e1,e2… then click/fill by ref
web-plane lane work click e3
web-plane lane work eval "navigator.webdriver"           # => false (confirm stealth)
```
`-s` is the profile (login identity, one Chrome process); `--as` is your lane (one daemon +
one labelled tab). Several agents on one identity: same `-s`, different `--as`.

Drive through `web-plane lane`, not `agent-browser` directly. agent-browser owns the pinned
target; the wrapper activates it through CDP and adds web-plane's pre/post blocking-UI gate
without invalidating snapshot refs. A lane owns one tab; need a second page, take a second lane.

## Check it's actually on
```bash
web-plane doctor      # patch / clone signature / clone version / dylib / agent-browser / sessions
```
Stealth degrades quietly rather than failing — a missing playwright patch silently falls back
to the *system* Chrome with no hook, so windows appear and `hide` can only minimize. If you
see a window, run `doctor` before anything else.

## Hide / show — web-plane owns visibility; driving continues either way
```bash
web-plane -s=main hide            # window invisible, CDP control unaffected
web-plane -s=main show            # raises to the foreground (steals focus — that's the point)
web-plane -s=main status          # session, PID, CDP port, hidden/minimized/visible
web-plane -s=main close
```
Visibility is per *profile*, not per lane — one browser, one window. Showing it shows
whatever tab is in front, so snapshot your lane immediately before `show` for a human handoff.
Hidden is the resting state; `show` is only for a staged human handoff — see "Visibility
choreography" in SKILL.md. Because `show` grabs the foreground, never fire it casually;
fire it once, when the screen is exactly the one the human must act on. `show` also
recovers a window the user minimized by hand.

## Caveats
- macOS only.
- **Focus is not taken on launch, but that rests on a private AppKit selector.** The
  activation came from AppKit's window restoration, not from Chromium, and the dylib
  suppresses it at that funnel — measured at 0ms across runs. If a macOS update renames the
  selector the hook declines to install and a fallback hands focus back instead, which
  degrades to a brief blink rather than silence. So: if a launch ever visibly grabs your
  keyboard, that is the signal, not a nuisance — re-run `web-plane install`, and if it
  persists see `docs/window-and-focus.md`.
- The clone carries Chrome's own updater and generally tracks your system version by itself;
  `web-plane doctor` says when it has actually drifted. Re-run `install` then, not reflexively.
- CAPTCHA / MFA still need the human — see the common layer in SKILL.md.
- Older builds lack `attach` / `lane` / `doctor`; if `web-plane --help` doesn't list them,
  update web-plane.
