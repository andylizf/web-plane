# Native panel control

## Scope

Give an agent narrow control over an active macOS Save/Open panel owned by a
managed Chrome process:

```text
web-plane -s=<session> panel status
web-plane -s=<session> panel accept --path /absolute/path
web-plane -s=<session> panel cancel
```

This is not general desktop automation. JavaScript dialogs remain Playwright's
responsibility, file inputs should use `setInputFiles`, and protected system UI
(Touch ID, Keychain, passwords, privacy consent) is not generically automated.
The agent decides whether to wait, abort the owning request, or show it to a
human.

## Design

The CLI resolves the exact managed Chrome process and sends a versioned JSON
request through a per-run file in web-plane's private run directory. `SIGINFO`
wakes the existing injected dylib, which processes fresh requests on AppKit's
main thread and writes a matching JSON response. Unique request IDs permit
concurrent callers; an age limit and panel generation ID reject stale actions.

The native side only recognizes `NSSavePanel` and `NSOpenPanel`. In a hidden
session it intercepts asynchronous presentation before the panel enters its
running phase, when public AppKit path configuration is still valid. Save can
complete without presenting UI. Open briefly initializes macOS's remote panel
service behind an alpha-zero, click-through proxy, verifies that `panel.URL`
exactly matches the requested path, then closes the service and returns OK to
the caller. No global Accessibility permission is needed.

The bridge exposes typed state and three actions; it never accepts Objective-C
selectors or generic UI instructions. Paths must be absolute. A visible session
is never intercepted. A hidden pending panel stays deferred until a typed action
handles it or the agent explicitly shows the session for human interaction.

## Failure behavior

- No managed session, missing run ID, no active panel, stale request, changed
  panel, invalid path, and unsupported native UI are distinct machine-readable
  errors.
- A panel already visible before this runtime cannot be accepted reliably; it
  can be cancelled and re-triggered while hidden.
- Panel completion is not proof that a download completed. The caller
  must still verify the resulting file or browser event.
- A Chrome-owned Recover/permission/download bubble is not a panel and remains
  cloaked while the browser session is hidden.

## Verification

Unit tests cover CLI parsing, path validation, and response matching. A native
host test on mac-mini proves stale-request rejection, Save/Open exact paths,
cancel, visible-session pass-through, human fallback, zero composited alpha, and
no foreground activation. A package smoke then verifies the same path in Chrome.
