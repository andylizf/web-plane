# Hiding a window is not hiding an app

Twelve of this repo's first thirty-four commits changed window-hiding behaviour.
They all moved along one axis — miniaturize, park offscreen, add an enforcement
timer, catch popups, swap miniaturize for alpha-zero — and users kept reporting
that launching a hidden session took their keyboard anyway. This document exists
so the next change starts from what is actually two problems.

## The two axes

**Window visibility** is what `cloak()` handles: `setAlphaValue:0` plus a move to
(-9999, -9999), re-asserted on a 16ms timer because Chrome's NSWindow subclass
overrides the setters and undoes a one-shot change during relayout. This part
always worked. Nobody ever saw a window.

**Application activation** is separate. macOS grants the foreground to an
*application*, not to a window. Every window can be transparent, parked off every
display, and never ordered front, and the app owning them can still be frontmost —
the menu bar switches to it and keystrokes stop reaching whatever the user was
typing in. The symptom is "focus was stolen" with no window ever visible, which
is why it kept getting filed as a window bug and kept surviving window fixes.

## The actual cause

Not Chromium. An lldb trace of the injected clone caught it:

```
SLSSetFrontProcessWithInfo                                   (SkyLight)
_NSSetFrontProcessWithInfo                                   (AppKit)
_NXActivateSelf
-[NSApplication _activateWithInfo:]
-[NSApplication _activateUsingEvent:ignoringOtherApps:unhideIfNeeded:allowingDeferral:]
-[NSApplication _reopenWindowsAsNecessaryIncludingRestorableState:withFullFidelity:completionHandler:]
-[NSPersistentUIManager restoreAllPersistentStateWithFullFidelity:completionHandler:]
-[NSDocumentController _autoreopenDocumentsIgnoringExpendable:withCompletionHandler:]
```

**AppKit's own window-state restoration — "Resume" — activates the app from its
completion handler, unconditionally, about a second after launch.** It reaches
SkyLight through a private funnel and never calls `activateIgnoringOtherApps:`,
`activate`, or anything on `NSRunningApplication`.

That single fact explains every earlier dead end. Chromium *does* call
`[NSApp activateIgnoringOtherApps:YES]` at startup, and the hook on it does stop
that call — it was simply never the call that mattered.

Setting `ApplePersistenceIgnoreState=YES`, the documented way to disable Resume,
does **not** help: the activation lives in the completion handler, which runs
whether or not there is any state to restore. Verified end to end.

## What was measured

macOS 26.2, Chrome 150, hidden launch, observed by `tests/native/focusmon.m`.
Time is how long the clone held the foreground:

| State | Focus held |
|---|---|
| Cloaking only (before this work) | **6180 ms** |
| \+ hooks on `activateIgnoringOtherApps:`, `activate`, both `NSRunningApplication` activations | 4571 ms |
| \+ makeKey half of `makeKeyAndOrderFront:` suppressed | 2233 ms |
| \+ activation policy `Accessory` | no further effect |
| \+ hand focus back on `NSApplicationDidBecomeActiveNotification` | 14–52 ms |
| \+ **hook `-[NSApplication _activateWithInfo:]`** | **0 ms** |

Zero, three runs out of three, with the browser alive each time.

## Rejected, with reasons

**`NSApplicationActivationPolicyAccessory`** — ineffective. It removes the Dock
tile and the Cmd-Tab entry and nothing else; the observer recorded the clone
taking the front with `policy=Accessory` already in effect. The trace shows why:
this path never consults the policy.

**`NSApplicationActivationPolicyProhibited`** — effective and unusable. Focus
stayed clean for three runs, then Chrome exited while loading a real page (it
survived `about:blank` for 16s; the same URL under the unpatched dylib kept its
process alive). It works by making the process ineligible for the foreground,
which the browser does not tolerate.

Switching policy also broke `show`: flipping back to Regular inside the SIGUSR2
handler left the window miniaturized in the Dock with its alpha restored — the
exact failure `tests/integration/hide-show.test.js` covers since d787200. It
turned that test red. No policy is set anywhere in the dylib now, deliberately.

**Hooking only the public activation APIs** — all four are still hooked and each
measurably lowered the stolen interval, but they cannot close it, because the
activation that matters is not an Objective-C call. Note too that
`activateIgnoringOtherApps:` is what macOS 14 deprecated for cooperative
activation, so on 26.x a hook on it alone is close to decorative.

## What is in place

1. **`-[NSApplication _activateWithInfo:]` swizzled to a no-op while hidden.**
   This is the fix. Private selector, so it is looked up by name, and applied
   only if the type encoding still matches `v24@0:8@16` — a changed encoding
   means AppKit changed the method, and calling through with a stale signature
   would corrupt the stack, so the hook declines rather than guesses.
2. **Focus hand-back** on `NSApplicationDidBecomeActiveNotification`, with the
   16ms timer re-checking. Dead code on a healthy build; it exists so that if a
   future OS renames the private selector and (1) declines to install, the
   failure is a blink rather than a return to six seconds.
3. **The public activation hooks**, likewise as fallback.
4. **Self-activation only.** The `NSRunningApplication` hooks refuse activation
   when `processIdentifier == getpid()` and pass everything else through, because
   handing the foreground back *is* an activation of another app.
5. **Browser process only.** The dylib is injected into every renderer, GPU and
   utility child; they are filtered out by `--type=` in the argument list.

An alternative that also measured clean is launching through LaunchServices with
`open -g -j -n --env DYLD_INSERT_LIBRARIES=… -a <clone>` and attaching via
`connectOverCDP`. `-g` is `kLSLaunchDontSwitch` and the DYLD injection survives.
It was not taken because it replaces Playwright's `launch()` with a connect-only
path and gives up the direct child-process handle — a much larger change than one
swizzle. Worth revisiting if the private selector ever disappears.

## Verifying a change

```bash
./tests/focus-steal.sh <label>      # one launch, judged by an independent observer
```

Three failure modes this harness exists to survive, two of which produced a false
pass before it did:

- **A clean log from a race.** One run is not evidence — an earlier build passed
  once and failed the next four times. Run it at least three times.
- **A clean log from a dead browser.** A patch that killed Chrome outright passed
  three times running, because a browser that never started never takes focus.
  Liveness is part of the verdict now: no live process reports `INVALID`, not
  `CLEAN`.
- **A green integration suite from a locked screen.** While the Mac is locked
  macOS composites only the lock window, so every window looks invisible and
  visibility assertions pass without proving anything. `test:integration` refuses
  to run in that state; that refusal is a feature, not a flake.

`tests/native/focusmon.m` is the observer. It listens to
`NSWorkspaceDidActivateApplicationNotification` *and* polls `frontmostApplication`
at 50ms, and logs each event with the app's real activation policy. Two sources
because the notification alone has a blind spot; the policy field so that "did the
patch apply?" is an observation rather than an inference from silence. It runs
itself under Prohibited so it can never appear in its own log.

`tests/integration/focus.test.js` wraps the same observer in the normal suite,
and `tests/native/selcheck.m` asserts that the private selector the fix hangs on
still exists with the expected type encoding — that one needs no browser and no
display, so it can fail loudly on a new macOS before anyone notices focus theft
has quietly returned.

## The Dock race: why `show` must use makeKeyAndOrderFront:

`deminiaturize:` looks like the obvious way to undo a minimize. It is the wrong
call, and the reason is in Chromium's own source
(`components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm`):

```objc
- (void)miniaturize:(id)sender {
  _miniaturizationInProgress = YES;      // async round trip with the Dock
  [super miniaturize:sender];
}
- (void)_regularMinimizeToDock {
  if (!_miniaturizationInProgress) { return; }   // cancelled — do nothing
  _miniaturizationInProgress = NO;
  [super _regularMinimizeToDock];                // otherwise: minimize anyway
}
- (void)makeKeyAndOrderFront:(id)sender { _miniaturizationInProgress = NO; ... }
- (void)orderOut:(id)sender             { _miniaturizationInProgress = NO; ... }
```

Chromium's comment names the AppKit bug it is working around: AppKit does not
cancel an in-flight miniaturize, so the Dock call lands later and minimizes the
window regardless. Chromium disarms that in exactly two overrides —
`makeKeyAndOrderFront:` and `orderOut:` — and **`deminiaturize:` is not one of
them**.

So a handler calling `deminiaturize:` restores the window and then loses it
about a second later. Measured with `tests/tools/trace-minimize.mjs`: on screen
at +200ms, gone by +600ms, and thereafter absent from the Accessibility list
because the end state is *ordered out*, not miniaturized. Whether an assertion
saw the good frame was luck, which is what made the suite alternate green and
red on unchanged code — CI passed on 07-31 and failed on 08-05 with the same
runner image (`20260728.0273.1`) and the same macOS (26.5.2 / 25F84). No version
drift was involved; a race is exactly what behaves that way.

CDP is not an escape hatch either. `Browser.setWindowBounds {windowState:
'normal'}` reaches `NativeWidgetMac::Restore()` → `SetMiniaturized(false)` →
`[window_ deminiaturize:nil]` — the same call, the same race. And once Chrome
believes the window is already normal, `browser_handler.cc` takes no branch at
all, so the request is a literal no-op.

## Two measurement traps this cost time on

**`kCGWindowListOptionOnScreenOnly` covers the active Space only.** With a
fullscreen app on another Space, every window of every application reads as
off-screen. That is indistinguishable from a window that failed to restore, and
it is why the assertions here are written against the Accessibility minimized
flag instead of on-screen-ness.

**An empty AX window list is not an error.** `AXWindows` enumerates *visible*
windows: a miniaturized window is listed with `minimized=true`, while a window
that has been ordered out is not listed at all. "Nothing is minimized" is
therefore the correct post-condition for a restore — asserting that some window
reports `minimized=false` demands it still be listed, which only holds on one of
the two legitimate outcomes.

A third, from `ui/base/ui_base_features.cc` and the bridge: with
`kAlphaInsteadOfCATransaction` (default on Mac) Chromium parks a window's alpha
in `pending_alpha_value_` and restores it only when a correctly-sized compositor
frame arrives. External alpha writes are not authoritative — Chromium overwrites
them when the frame lands.
