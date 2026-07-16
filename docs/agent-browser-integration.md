# Design: agent-browser integration (`web-plane cdp`)

Date: 2026-07-16
Status: Proposed

## Motivation

web-plane and [agent-browser](https://github.com/vercel-labs/agent-browser) currently
read as competitors — the README even opens by contrasting them (agent-browser downloads
Chrome for Testing, ships `navigator.webdriver=true`, and gets caught by Cloudflare). In
practice they are **orthogonal and complementary**:

- **agent-browser** is a strong *operation layer*: a persistent daemon (~1ms warm
  commands), ref-based accessibility snapshots, and a broad command surface
  (network/cookies/storage/tab/diff). Its weakness is the default engine — Chrome for
  Testing, headless, `webdriver=true`, detectable.
- **web-plane** is a strong *stealth kernel*: a cloned, re-signed real Chrome
  (`webdriver=false`, real UA, Cloudflare-proof) plus a macOS-only "zero flash" invisible
  window (DYLD-injected `window_suppress.dylib` + SIGUSR show/hide) that does not steal
  focus. Its operation layer is just a thin proxy over playwright-cli.

The pairing is: **agent-browser as the hands, web-plane as the disguise.** Point
agent-browser at web-plane's hidden real Chrome over CDP and you get agent-browser's
ergonomics with web-plane's undetectability, invisibly, without stealing the user's focus.

## Verified feasibility (not theoretical)

Measured on 2026-07-16, macOS, against a live hidden session:

- web-plane's hidden Chrome already launches with a **tcp `--remote-debugging-port`**
  (playwright-cli opens a tcp port, not a pipe). `web-plane status` already prints it.
- `agent-browser connect <port>` attaches successfully.
- Once attached: `navigator.webdriver === false`, UA is a normal
  `Chrome/150.0.0.0` (no "HeadlessChrome") — stealth intact, because the kernel is the
  cloned real Chrome.
- agent-browser drives it normally (navigate, eval, snapshot).
- After `web-plane hide`, agent-browser still drives it (eval returns results) — window
  visibility is independent of CDP control.

Two caveats surfaced and must be documented:

1. Connecting to a multi-tab Chrome lands agent-browser on some existing target (a
   profile-restored tab), not necessarily the one you want — callers must select with
   `agent-browser tab`.
2. Right after `web-plane hide`, one `document.title` read came back empty while
   arithmetic eval still worked — likely an active-target switch during hide. To be
   pinned down during implementation; does not block the approach.

## Design

### New command: `web-plane cdp [-s=<name>] [--port <N>]`

Turns web-plane into a stealth-kernel provider for external CDP drivers.

Behavior:

1. Reuse the existing `open` injection path (`--headed`, `--profile`, `--config`, and the
   DYLD-injected hidden real Chrome) to ensure a hidden session is running for the given
   `-s` name (default session if omitted). If one is already running for that session,
   reuse it.
2. Resolve the session's CDP tcp port (the same lookup `web-plane status` /
   `lib/window.js#getCdpPort` already does).
3. Print the port and a ready-to-paste line:
   ```
   CDP port: <N>
   Attach:   agent-browser connect <N>
   ```

Port strategy:

- **MVP:** let playwright-cli pick the port (random, as today) and print it. Zero new
  launch plumbing.
- **Optional (`--port <N>`):** inject `--remote-debugging-port=<N>` into the Chrome launch
  args for a predictable port that a SKILL.md can hardcode. Implementation must confirm how
  playwright-cli forwards an extra Chrome flag (temporary config override vs CLI passthrough)
  and error clearly if `<N>` is already bound by another session.

web-plane keeps ownership of `show` / `hide` / `status` / `close`; agent-browser owns all
page operations. No operation logic is duplicated.

### `install` — unchanged

Cross-machine "easily installable" is already satisfied by the existing idempotent
`web-plane install` (APFS clone + compile dylib + patch playwright). The integration adds
no new install step for web-plane itself. agent-browser is a separate `npm i -g
agent-browser && agent-browser install`, documented in the SKILL.md rather than bundled.

### New file: `SKILL.md` (repo root or `skills/`)

A tool-agnostic instruction doc any agent (Claude Code, Codex, Cursor, Gemini) can read.
Sections:

- **When to use:** you need to drive a browser stealthily / undetectably on macOS, without
  a visible window stealing focus.
- **One-time install:** `npm i -g web-plane && web-plane install` and
  `npm i -g agent-browser && agent-browser install`.
- **Run:** `web-plane cdp` → copy the printed `agent-browser connect <port>`.
- **Drive:** normal agent-browser commands; use `agent-browser tab` to select the right
  page on a multi-tab session.
- **Visibility:** `web-plane hide` / `show` — control never breaks when hidden.
- **Caveats:** macOS only; re-run `web-plane install` after a Chrome update; CAPTCHAs / MFA
  still require a human.

### README update

Reframe the agent-browser mention from "detectable competitor" to "pair them": add a short
"Use with agent-browser" section showing `web-plane cdp` → `agent-browser connect`, so the
opening contrast resolves into a combination rather than a rivalry.

## Error handling / edge cases

- Chrome not installed / dylib not compiled → the existing `install` guard fires; `cdp`
  should point the user to `web-plane install`.
- `--port <N>` already in use → fail fast with a clear message naming the conflicting
  session if detectable.
- No session running when `cdp` is called → it starts one (that is its job).
- Multi-tab target selection and the post-hide empty-title anomaly → documented in
  SKILL.md and investigated during implementation.

## Testing

The repo has no test framework today; do not introduce one for this. Validation is a
manual smoke chain, scripted for repeatability, mirroring the feasibility test:

`web-plane cdp` → `agent-browser connect <port>` → assert `navigator.webdriver === false`
→ navigate + read title → `web-plane hide` → assert eval still works → `web-plane close`.

Ship this as a `docs/` or `scripts/` smoke script so it can be re-run after Chrome/playwright
bumps.

## Non-goals (YAGNI)

- No web-plane-internal "call agent-browser as backend" mode (too coupled).
- No Linux support (web-plane is macOS-only by design).
- No auto-installing agent-browser from web-plane (SKILL.md instructs it).

## Rollout

1. Implement on a feature branch in the local clone.
2. Run the smoke chain locally.
3. Review the diff with the maintainer.
4. Push / open PR to `andylizf/web-plane` **only after explicit approval** — no push before
   the maintainer has seen the exact diff.
