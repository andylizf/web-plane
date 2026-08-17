# Unified UI blocker gate

## Decision

Every page command crosses one UI-state boundary. The UI-owning layer reports
blocking facts; `lib/ui.js` assigns the available actions; `web-plane lane`
enforces the result before and after agent-browser runs.

Detection never shows a window. Showing the session is an explicit agent choice.

## Sources and ownership

- Renderer dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) stay with the
  browser driver that owns their events.
- Chrome child-modal UI is detected by the injected AppKit bridge. A visible,
  keyable `NativeWidgetMacNSWindow` whose parent is a
  `BrowserNativeWidgetWindow` blocks the active tab. Titles are reported but
  never matched.
- Typed Save/Open panels retain their narrow `panel accept` and `panel cancel`
  actions.
- Other native or protected UI is reported without generic clicking. The agent
  may wait, abort the owning request when possible, or explicitly show the
  session for a human.

Unparented Chrome surfaces such as Recover and download-history bubbles are not
blockers. They remain cloaked with the hidden browser.

## Command boundary

After resolving the lane's persistent pinned target:

The target activation, pre-check, command, and post-check boundary is serialized
per browser profile. Chrome exposes only one selected tab, so a second lane must
not change it while the first lane is detecting tab-native UI.

1. Read UI state. Refuse page input if any blocker is active.
2. Allow inspection and navigation so the agent can diagnose or abort.
3. Run the command.
4. Read UI state again. If a new blocker appeared, report that the command ran
   but another page input must not follow. Bind a new tab-scoped blocker's
   stable native ID to the lane whose command exposed it.

Chrome leaves a tab-modal child window visible to AppKit even after CDP selects
another tab, so visibility alone cannot determine its owner. A known owner gates
only that lane; an unowned blocker fails closed until its origin is known or it
is dismissed. Ownership is scoped to the browser run and removed with it.

Unknown future agent-browser commands are treated as input until explicitly
classified safe. A failed blocker query also fails closed for page input.

## Deliberate exclusions

- No `WebAuthn.enable`: it changes credential handling by installing a virtual
  authenticator rather than passively observing UI.
- No Accessibility permission or localized-title matching.
- No generic click/close action for unknown browser or system UI.
- No daemon; the existing run-scoped request bridge remains sufficient.

## Verification

- Pure tests cover command policy, action policy, and pre/post blocker changes.
- An injected AppKit host proves that a parented Chrome child is blocking while
  an unparented Chrome popover is not.
- Existing Save/Open and window/focus integration suites remain green.
- A real Chrome test on mac-mini triggers WebAuthn, verifies post-command
  reporting and pre-command refusal, navigates to abort, and confirms input
  resumes without foreground activation.
