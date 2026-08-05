// Zero-flash Chrome: suppress window show until signal file is removed.
// Signal file: /tmp/.chrome-suppress-<pid>
// When file exists → order normally but fully transparent and offscreen
// When file deleted (by Playwright after CDP ready) → pass through
//
// Post-launch hide/show via Unix signals:
//   SIGUSR1 → hide all windows (setAlphaValue:0)
//   SIGUSR2 → show all windows (deminiaturize + setAlphaValue:1)
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <unistd.h>
#include <stdio.h>
#include <signal.h>

static char signalPath[256];
static char hiddenPath[256];
static BOOL initialized = NO;

static void initPaths(void) {
    if (!initialized) {
        snprintf(signalPath, sizeof(signalPath), "/tmp/.chrome-suppress-%d", getpid());
        snprintf(hiddenPath, sizeof(hiddenPath), "/tmp/.chrome-hidden-%d", getpid());
        initialized = YES;
    }
}

static BOOL shouldSuppress(void) {
    initPaths();
    return access(signalPath, F_OK) == 0;
}

// Standing-hidden flag, written by `web-plane hide` and removed by `show`.
// While it exists, windows may order front normally (so Chrome's internal
// bookkeeping stays truthful — replacing orderFront with miniaturize desyncs
// it and Chrome then ignores all CDP bounds commands), but they are cloaked
// right after: transparent and parked offscreen. Both are cosmetic operations
// AppKit reports honestly, so no state ever diverges.
static BOOL isHidden(void) {
    initPaths();
    return access(hiddenPath, F_OK) == 0;
}

// Where a window sat before it was parked offscreen, so `show` can put it back.
//
// Parking is half of hiding (the half that stops an invisible window swallowing
// clicks, 401153b) but nothing used to undo it: SIGUSR2 restored alpha only, and
// the windows still came back because `show` separately repositions them over
// CDP. That covers every window Chrome knows about — and silently misses the ones
// it does not. macOS injects windows into the process that Chrome never sees, and
// the Screen Time lockout panel is one of them: measured after `show`, the
// lockout window was alpha 1 and still at (-9999, 10181), i.e. visible in every
// sense the API reports and physically off the display. The user gets a black
// window with no explanation and cannot click "Ignore Limit", because the button
// is a screen away.
static const void *kParkedOriginKey = &kParkedOriginKey;

static void cloak(NSWindow *w) {
    // Record the real origin once. Re-cloaking an already-parked window must not
    // overwrite it with (-9999, -9999), or the way home is lost.
    if (!objc_getAssociatedObject(w, kParkedOriginKey)) {
        NSPoint o = [w frame].origin;
        if (o.x > -9000.0 && o.y > -9000.0) {
            objc_setAssociatedObject(w, kParkedOriginKey,
                                     [NSValue valueWithPoint:o],
                                     OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    }
    [w setAlphaValue:0.0];
    [w setFrameOrigin:NSMakePoint(-9999, -9999)];
}

// Undo the parking half. Safe to call on a window that was never parked (no
// association, nothing happens) and on one Chrome will reposition anyway over
// CDP — that lands on the same or a better place a moment later.
static void unpark(NSWindow *w) {
    NSValue *v = objc_getAssociatedObject(w, kParkedOriginKey);
    if (!v) return;
    [w setFrameOrigin:[v pointValue]];
    objc_setAssociatedObject(w, kParkedOriginKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

// Cloaking hides windows. It cannot stop the app from being activated, because
// activation is granted to the *application*, not to any of its windows: a
// launching process is brought to the front by the system, without calling any
// NSWindow method we could swizzle. Measured on macOS 26.2 before this existed:
// the clone went frontmost 5.6s into a hidden launch and held it for 6.2s, with
// every window correctly transparent and parked offscreen the whole time. The
// user saw no window and still lost the keyboard.
//
// No activation policy is set here, and that is a conclusion rather than an
// omission. Both options were tried and measured on 26.2:
//
//   Accessory   Ineffective. It removes the Dock tile and the Cmd-Tab entry but
//               leaves the app eligible to be activated — the observer recorded
//               the clone taking the front with policy=Accessory already in
//               effect. An lldb trace later showed why: the activation path does
//               not consult the policy at all.
//   Prohibited  Effective, and unusable. Focus stayed clean across three runs,
//               then Chrome exited while loading a real page (it survived
//               about:blank for 16s; the same URL under the unpatched dylib kept
//               its process alive). Prohibited works by making the process
//               ineligible for the foreground, which the browser does not
//               tolerate.
//
// Worse, switching policy on `show` broke it: flipping back to Regular in the
// SIGUSR2 handler left the window miniaturized in the Dock with alpha restored —
// exactly the failure that `tests/integration/hide-show.test.js` was written for
// after d787200, and it went red. Activation is dealt with at its real entry
// point instead (see the _activateWithInfo: hook below).

// Chrome's renderers, GPU and utility children inherit DYLD_INSERT_LIBRARIES,
// so this constructor runs in every one of them. Only the browser process owns
// the app's activation state; letting a child instantiate NSApp just to change
// a policy it does not own would spin up AppKit in a process designed never to
// need it. Children are the ones carrying --type=.
static BOOL isBrowserProcess(void) {
    for (NSString *arg in [[NSProcessInfo processInfo] arguments]) {
        if ([arg hasPrefix:@"--type="]) return NO;
    }
    return YES;
}

// Who had the keyboard when this process started — the app to hand it back to.
static pid_t gPrevFrontPid = 0;

// Backstop. The _activateWithInfo: hook below prevents the activation outright
// and measures zero stolen focus, so on a healthy build this never fires. It is
// kept because that hook rests on a private selector: if a future AppKit renames
// it, the guard there declines to swizzle and this is what stops a silent
// regression back to seconds of stolen focus.
//
// Undoing an activation rather than preventing it: hand the foreground back to
// whoever had it. That is an ordinary activation of *another* process, which the
// OS permits and which the self-activation guards deliberately let through.
// Driven by the DidBecomeActive notification (and re-checked on the 16ms timer),
// it measured 14-52ms of stolen focus on its own — a visible blink, which is why
// it is the fallback and not the fix.
static void yieldFocusBack(void) {
    if (gPrevFrontPid <= 0) return;
    if (![[NSRunningApplication currentApplication] isActive]) return;
    NSRunningApplication *prev =
        [NSRunningApplication runningApplicationWithProcessIdentifier:gPrevFrontPid];
    // Gone, or it is us: nothing to give the keyboard back to, and activating
    // ourselves here would be the very bug this function exists to undo.
    if (!prev || prev.processIdentifier == getpid()) return;
    [prev activateWithOptions:0];
}

// Signal handlers — dispatch to main thread for AppKit safety
static void handleSIGUSR1(int sig) {
    dispatch_async(dispatch_get_main_queue(), ^{
        for (NSWindow *w in [NSApp windows]) {
            [w setAlphaValue:0.0];
        }
    });
}

static void handleSIGUSR2(int sig) {
    dispatch_async(dispatch_get_main_queue(), ^{
        for (NSWindow *w in [NSApp windows]) {
            // Hiding is TWO acts — miniaturize, then alpha 0 — so showing has to
            // undo both. Restoring only the alpha left the window genuinely
            // miniaturized, parked in the Dock's minimized tray where nobody
            // thinks to look, while every signal we check said it was fine:
            // Chrome reports windowState normal (it never saw the minimize, we
            // did it behind its back), and CGWindowList reports alpha 1 with
            // correct bounds (a miniaturized window keeps both).
            // makeKeyAndOrderFront:, deliberately not deminiaturize:.
            //
            // Chromium overrides -miniaturize: to set _miniaturizationInProgress
            // and start an async round-trip with the Dock, then checks that flag
            // in -_regularMinimizeToDock. Its own comment records why: AppKit
            // does not cancel an in-flight miniaturize, so the Dock call lands
            // later and minimizes the window anyway. Chromium disarms it in
            // exactly two overrides — makeKeyAndOrderFront: and orderOut: — and
            // deminiaturize: is not one of them
            // (components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm).
            //
            // So deminiaturize: restored the window and then lost it about a
            // second later, when _regularMinimizeToDock ran with the flag still
            // set. Measured: on screen at +200ms, gone by +600ms, and afterwards
            // absent from the Accessibility list because the end state is
            // ordered-out rather than miniaturized. Whether an assertion caught
            // the good frame was luck, which is what made this test alternate
            // green and red on unchanged code.
            //
            // CDP's `windowState: normal` is not an alternative: it reaches
            // NativeWidgetMac::Restore() -> SetMiniaturized(false) ->
            // [window_ deminiaturize:nil], the same call with the same race.
            if ([w isMiniaturized]) [w makeKeyAndOrderFront:nil];
            [w setAlphaValue:1.0];
            // Third act, added after the first two proved insufficient: bring it
            // back from (-9999, -9999). Without this a window Chrome does not
            // manage — a system-injected panel such as Screen Time's lockout —
            // reports itself fully shown while sitting off the display.
            unpark(w);
        }
    });
}

__attribute__((constructor))
static void init(void) {
    // Populate signalPath AND hiddenPath. Must go through initPaths(), not a
    // bare snprintf: setting `initialized = YES` after filling only signalPath
    // would leave hiddenPath empty forever (initPaths early-returns once the
    // flag is set), so isHidden() could never see the hidden marker.
    initPaths();
    // Create both flags before Chrome constructs its first window.  The launch
    // flag is consumed by the Playwright patch once CDP is ready; the standing
    // hidden flag remains until an explicit `web-plane show`.  Previously the
    // launch hook called miniaturize:, which kept the content window out of
    // CGWindowList but still produced a visible macOS/Dock minimize animation.
    // Starting in the same alpha-zero/offscreen state used by normal `hide`
    // removes that animation while keeping Chrome's window bookkeeping true.
    FILE *f = fopen(signalPath, "w");
    if (f) fclose(f);
    f = fopen(hiddenPath, "w");
    if (f) fclose(f);

    // Register signal handlers for post-launch hide/show
    signal(SIGUSR1, handleSIGUSR1);
    signal(SIGUSR2, handleSIGUSR2);

    Class cls = [NSWindow class];
    SEL sels[] = {
        @selector(makeKeyAndOrderFront:),
        @selector(orderFront:),
        @selector(orderFrontRegardless),
    };
    // Saved so the makeKeyAndOrderFront: hook can order a window in *without*
    // the makeKey half. Filled on the i==1 pass; the block below only reads it
    // at call time, long after this loop has finished.
    static IMP origOrderFront = NULL;
    static SEL orderFrontSel = NULL;
    for (int i = 0; i < 3; i++) {
        SEL sel = sels[i];
        Method m = class_getInstanceMethod(cls, sel);
        IMP origIMP = method_getImplementation(m);
        if (i == 1) { origOrderFront = origIMP; orderFrontSel = sel; }
        IMP newIMP;
        if (i < 2) {
            BOOL isMakeKey = (i == 0);
            newIMP = imp_implementationWithBlock(^(NSWindow *self, id sender) {
                if (shouldSuppress() || isHidden()) {
                    cloak(self);
                    // Making a window key is itself an activation request: the
                    // system brings the owning app forward so the key window can
                    // receive typing. Cloaking cannot prevent that, because the
                    // window's alpha and position have nothing to do with who
                    // owns the keyboard — which is why focus was still being
                    // taken with every window correctly transparent, offscreen,
                    // the app already Accessory, and all three activation APIs
                    // hooked. Order the window in, skip the makeKey.
                    if (isMakeKey && origOrderFront) {
                        ((void(*)(id, SEL, id))origOrderFront)(self, orderFrontSel, sender);
                    } else {
                        ((void(*)(id, SEL, id))origIMP)(self, sel, sender);
                    }
                    cloak(self);
                    return;
                }
                ((void(*)(id, SEL, id))origIMP)(self, sel, sender);
                if (isHidden()) cloak(self);
            });
        } else {
            newIMP = imp_implementationWithBlock(^(NSWindow *self) {
                if (shouldSuppress()) {
                    cloak(self);
                    ((void(*)(id, SEL))origIMP)(self, sel);
                    cloak(self);
                    return;
                }
                ((void(*)(id, SEL))origIMP)(self, sel);
                if (isHidden()) cloak(self);
            });
        }
        method_setImplementation(m, newIMP);
    }
    // Cloak at the ordering primitive: window.open popups (and other windows)
    // become visible through orderWindow:relativeTo: without ever calling the
    // three high-level methods hooked above, so the standing-hidden check must
    // live here to catch every path onto the screen. Cloak BEFORE the original
    // runs too, so the window is already transparent+offscreen the instant it
    // is ordered in — otherwise there's a one-frame flash before we react.
    {
        SEL sel = @selector(orderWindow:relativeTo:);
        Method m = class_getInstanceMethod(cls, sel);
        IMP origIMP = method_getImplementation(m);
        method_setImplementation(m, imp_implementationWithBlock(
            ^(NSWindow *self, NSWindowOrderingMode place, NSInteger otherWin) {
                BOOL hide = (place != NSWindowOut) && isHidden();
                if (hide) cloak(self);
                ((void(*)(id, SEL, NSWindowOrderingMode, NSInteger))origIMP)(self, sel, place, otherWin);
                if (hide) cloak(self);
            }));
    }
    // Continuous enforcement while hidden. Method swizzling alone can't hold a
    // window hidden: Chrome's windows are an NSWindow *subclass* that overrides
    // setAlphaValue:/setFrame:, so their own calls bypass a base-class swizzle,
    // and after a popup's page loads Chrome re-runs layout and sets alpha back to
    // 1 at a position onscreen. Instead, re-assert the cloak on a fast timer:
    // setAlphaValue: itself does work on Chrome windows (the main window's
    // hide/show rely on it), so re-applying alpha 0 + offscreen every tick wins
    // the race against Chrome's relayout. Idle when not hidden (just a flag read).
    {
        // Defer scheduling to when the main queue first drains (proven to run
        // under Chrome's pump — the SIGUSR handlers use it), then install a
        // repeating NSTimer in the common run-loop modes so it keeps firing
        // through Chrome's CFRunLoop. A bare dispatch-source timer on the main
        // queue does not fire reliably inside Chrome's message pump.
        dispatch_async(dispatch_get_main_queue(), ^{
            NSTimer *t = [NSTimer timerWithTimeInterval:0.016 repeats:YES block:^(NSTimer *_t) {
                if (!isHidden()) return;
                // Backstop for the launch-time policy below. If anything set the
                // app back to Regular — or finishLaunching ran too late to beat
                // the system's activation — this pulls it out of the foreground
                // within a frame instead of leaving it there for seconds.
                yieldFocusBack();
                for (NSWindow *w in [NSApp windows]) {
                    if ([w alphaValue] > 0.0) [w setAlphaValue:0.0];
                    NSPoint o = [w frame].origin;
                    if (o.x > -9000 || o.y > -9000) [w setFrameOrigin:NSMakePoint(-9999, -9999)];
                }
            }];
            [[NSRunLoop mainRunLoop] addTimer:t forMode:NSRunLoopCommonModes];
        });
    }
    // Record the outgoing front app before Chrome can displace it. Read here in
    // the constructor, which runs before the browser has a window to steal with,
    // so the pid captured is genuinely the user's app rather than our own.
    if (isBrowserProcess()) {
        NSRunningApplication *front = [[NSWorkspace sharedWorkspace] frontmostApplication];
        if (front && front.processIdentifier != getpid()) {
            gPrevFrontPid = front.processIdentifier;
        }

        // Give the keyboard back the instant it arrives, rather than on the next
        // timer tick. The 16ms poll alone measured 47ms, 324ms and 661ms of
        // stolen focus across three runs — the spread is the poll waiting for a
        // run loop that is busy starting a browser. This notification fires as
        // part of the activation itself, so the hand-back is queued before the
        // user can finish a keystroke. The timer stays as the backstop for any
        // activation that somehow does not post it.
        [[NSNotificationCenter defaultCenter]
            addObserverForName:NSApplicationDidBecomeActiveNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification *note) {
            // Hidden flag only, for the same reason as the activation hook: the
            // suppress flag can outlive CDP coming up, and `show` never clears
            // it. Including it here made `show` undo itself — it activates the
            // app as its last step, this fired on that activation, and the
            // foreground went straight back to the previous app.
            if (isHidden()) yieldFocusBack();
        }];
    }

    // The door the focus actually walks out of.
    //
    // An lldb trace of the injected clone caught the real stack, and it is not
    // Chromium's:
    //
    //   SLSSetFrontProcessWithInfo                          (SkyLight)
    //   _NXActivateSelf                                     (AppKit)
    //   -[NSApplication _activateWithInfo:]
    //   -[NSApplication _activateUsingEvent:ignoringOtherApps:...]
    //   -[NSApplication _reopenWindowsAsNecessaryIncludingRestorableState:...]
    //   -[NSPersistentUIManager restoreAllPersistentStateWithFullFidelity:...]
    //
    // AppKit's own window-state restoration ("Resume") activates the app from its
    // completion handler, unconditionally, about a second after launch. It goes
    // through a private funnel and never touches activateIgnoringOtherApps:,
    // activate, or NSRunningApplication — which is exactly why hooking all three
    // lowered the stolen interval without ever closing it. Chromium *does* call
    // activateIgnoringOtherApps: at startup and the hook below does stop that one;
    // it simply was never the call that mattered.
    //
    // Suppressing this funnel was measured to keep the front app unchanged for a
    // whole run with SLSSetFrontProcessWithInfo never reached, and — unlike
    // Prohibited — the browser loads real pages and stays alive.
    //
    // Private selector, so: looked up by name, guarded on existence, and the
    // public hooks are kept as a fallback for an OS that renames it. Hidden state
    // is the gate, so `show` still activates normally for a human handoff.
    if (isBrowserProcess()) {
        SEL sel = NSSelectorFromString(@"_activateWithInfo:");
        Method m = class_getInstanceMethod([NSApplication class], sel);
        // Verified as v24@0:8@16 on 26.2 — void return, one object argument. A
        // different encoding means AppKit changed the method, and calling through
        // with the wrong signature would corrupt the stack; leave it alone and let
        // the fallbacks carry it.
        if (m && strcmp(method_getTypeEncoding(m), "v24@0:8@16") == 0) {
            IMP origIMP = method_getImplementation(m);
            method_setImplementation(m, imp_implementationWithBlock(^(NSApplication *self, id info) {
                // Gated on the hidden flag ALONE, never on the suppress flag.
                // The two mean different things: the suppress flag is launch-time
                // window handling, cleared by the playwright patch once CDP is up,
                // while the hidden flag is the standing hide/show state that
                // `show` clears (lib/window.js clears the hidden flag and
                // deliberately leaves the suppress file alone). Gating activation
                // on both made `show` unable to raise the app whenever the launch
                // flag outlived CDP — the window came back opaque and still buried,
                // failing three integration tests at once. Launch is still covered:
                // the constructor creates both flags, so isHidden() is true then too.
                if (isHidden()) return;
                ((void(*)(id, SEL, id))origIMP)(self, sel, info);
            }));
        }
    }

    // Block activation while suppressing
    {
        Class appCls = [NSApplication class];
        SEL sel = @selector(activateIgnoringOtherApps:);
        Method m = class_getInstanceMethod(appCls, sel);
        IMP origIMP = method_getImplementation(m);
        method_setImplementation(m, imp_implementationWithBlock(^(NSApplication *self, BOOL flag) {
            // A hidden session must never steal focus either.
            if (shouldSuppress() || isHidden()) return;
            ((void(*)(id, SEL, BOOL))origIMP)(self, sel, flag);
        }));
    }

    // -[NSApplication activate], the macOS 14 cooperative-activation replacement
    // for the call hooked above. Chrome 150's framework references both, and a
    // hook on the deprecated one alone leaves the current API wide open. Guarded
    // by a NULL check rather than an OS version test: if the running AppKit does
    // not have the selector there is nothing to hook and nothing to worry about.
    {
        SEL sel = @selector(activate);
        Method m = class_getInstanceMethod([NSApplication class], sel);
        if (m) {
            IMP origIMP = method_getImplementation(m);
            method_setImplementation(m, imp_implementationWithBlock(^(NSApplication *self) {
                if (shouldSuppress() || isHidden()) return;
                ((void(*)(id, SEL))origIMP)(self, sel);
            }));
        }
    }

    // The route that was actually open. NSRunningApplication is a *different
    // class* from NSApplication, so neither hook above sees a call made through
    // it, and `strings` on Chrome 150's framework lists all three selectors —
    // activate, activateIgnoringOtherApps:, activateWithOptions:. Blocking two
    // of three left the app free to raise itself through the third, which is
    // consistent with what the observer recorded: focus taken while the policy
    // was already Accessory and both NSApplication hooks were installed.
    //
    // Only self-activation is refused. Activating some *other* application is a
    // legitimate thing for this process to do — notably handing focus back — and
    // blocking that would strand the user's front app.
    {
        SEL sels[] = { @selector(activateWithOptions:),
                       @selector(activateFromApplication:options:) };
        for (int i = 0; i < 2; i++) {
            SEL sel = sels[i];
            Method m = class_getInstanceMethod([NSRunningApplication class], sel);
            if (!m) continue;
            IMP origIMP = method_getImplementation(m);
            if (i == 0) {
                method_setImplementation(m, imp_implementationWithBlock(
                    ^BOOL(NSRunningApplication *self, NSApplicationActivationOptions opts) {
                        if ((shouldSuppress() || isHidden()) &&
                            self.processIdentifier == getpid()) return NO;
                        return ((BOOL(*)(id, SEL, NSApplicationActivationOptions))origIMP)(self, sel, opts);
                    }));
            } else {
                method_setImplementation(m, imp_implementationWithBlock(
                    ^BOOL(NSRunningApplication *self, id fromApp, NSApplicationActivationOptions opts) {
                        if ((shouldSuppress() || isHidden()) &&
                            self.processIdentifier == getpid()) return NO;
                        return ((BOOL(*)(id, SEL, id, NSApplicationActivationOptions))origIMP)(self, sel, fromApp, opts);
                    }));
            }
        }
    }
}
