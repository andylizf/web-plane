# stealth — web-plane + agent-browser

The default for anything real: a logged-in session or a bot-protected site, on macOS.
web-plane provides a cloned, re-signed real Chrome (`navigator.webdriver=false`, real UA,
Cloudflare-proof) with a zero-flash hidden window that never steals focus; agent-browser
attaches over CDP and does the operating.

## Install (one-time)
```bash
npm install -g web-plane && web-plane install
npm install -g agent-browser && agent-browser install
```
`web-plane install` clones your system Chrome (APFS copy-on-write), compiles the DYLD
window-suppression hook, and patches a local playwright-cli under `~/.web-plane/`. Idempotent
— re-run after a Chrome update. Requires macOS, Google Chrome, Node ≥18, Xcode CLT.

## Drive
```bash
web-plane -s=work cdp             # prints Session / CDP port / Attach line
agent-browser connect <port>      # from the printed line
agent-browser tab list            # pick the right tab if there are several
agent-browser goto https://example.com
agent-browser snapshot            # refs e1,e2… then click/fill by ref
agent-browser eval "navigator.webdriver"   # => false (confirm stealth)
```

## Hide / show — web-plane owns visibility; agent-browser keeps driving either way
```bash
web-plane -s=work hide            # window invisible, CDP control unaffected
web-plane -s=work show            # raises to the foreground (steals focus — that's the point)
web-plane -s=work status          # session, PID, CDP port, hidden/minimized/visible
web-plane -s=work close
```
Hidden is the resting state; `show` is only for a staged human handoff — see "Visibility
choreography" in SKILL.md. Because `show` grabs the foreground, never fire it casually;
fire it once, when the screen is exactly the one the human must act on. `show` also
recovers a window the user minimized by hand.

## Caveats
- macOS only.
- Re-run `web-plane install` after Chrome updates (the clone must track your Chrome version).
- CAPTCHA / MFA still need the human — see the common layer in SKILL.md.
- `web-plane cdp` requires a web-plane build that has the `cdp` command; if `web-plane --help`
  doesn't list it, update web-plane.
