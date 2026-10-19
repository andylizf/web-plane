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
  `BrowserNativeWidgetWindow` blocks the active tab only when the parent's
  `topmostVisibleChildModalWindow` returns that child. Chromium derives this
  result from the Views widget's modal type. If the selector is unavailable,
  a parented child remains blocking. Titles are reported but never matched.
- Typed Save/Open panels retain their narrow `panel accept` and `panel cancel`
  actions.
- Other native or protected UI is reported without generic clicking. The agent
  may wait, abort the owning request when possible, or explicitly show the
  session for a human.

Chrome surfaces such as Recover and download-history bubbles remain cloaked with
the hidden browser. Download bubbles can be parented to the browser window, so
parentage alone does not establish modality. `ui status` reports non-blocking
browser UI in `surfaces`, with `blocking: false` and only `wait`/`show` actions;
`blockers` contains UI that gates input. Browser surfaces have no action that
aborts them by navigating the tab.

Before launching an idle managed profile, `prepareManagedProfile` merges
`download_bubble.partial_view_enabled: false` into `Default/Preferences`,
preserving other settings and using the existing code for atomic writes and
backups. This disables Chrome's automatic partial download bubble; manually
opened download UI still needs correct classification.

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

Chrome can hide and detach a tab-modal child when CDP selects another tab, then
restore the same native window when its tab is selected again. A known owner
gates only that lane; an unowned blocker fails closed until its origin is known
or it is dismissed. Ownership is scoped to the browser run and removed with it.

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
- An injected AppKit host distinguishes parented modal and non-modal children,
  including simultaneous surfaces with misleading titles, and verifies the
  fail-closed behavior when the Chromium selector is unavailable.
- A real Chrome regression downloads a local file with automatic bubbles
  enabled, verifies lane click/type and exact field readback while the bubble
  stays open, then verifies WebAuthn still gates input until navigation.
- Managed preference preparation preserves unrelated values and a backup; a
  second real download completes without opening the automatic bubble.
- Save/Open and window/focus integration suites cover existing panel and
  visibility behavior.
- A real Chrome test on mac-mini triggers WebAuthn, verifies post-command
  reporting and pre-command refusal, navigates to abort, and confirms input
  resumes without foreground activation.

### Measured Chrome properties

In an isolated Chrome 155.0.8059.79 profile, both the download bubble and a real
WebAuthn security-key dialog used `NativeWidgetMacNSWindow` parented to the same
`BrowserNativeWidgetWindow`. Both had `styleMask=0`, `level=0`,
`canBecomeKeyWindow=YES`, and `isSheet=NO`.

| Property | Download bubble | WebAuthn dialog |
| --- | --- | --- |
| Window size, points | 320 × 68 | 448 × 300 |
| Parent's `topmostVisibleChildModalWindow` | `nil` | The WebAuthn window |

The download bubble remained visible to AppKit while WebAuthn was open, and
Chromium selected only WebAuthn as the modal child. Geometry and localized
titles are evidence only. With `download_bubble.partial_view_enabled=true`, a
local download opened the bubble; with `false`, the same download completed
without opening it.

Chromium sources for this build define the
[child-modality selector](https://github.com/chromium/chromium/blob/155.0.8059.79/components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm)
and the
[automatic download-bubble preference](https://github.com/chromium/chromium/blob/155.0.8059.79/chrome/common/pref_names.h).
