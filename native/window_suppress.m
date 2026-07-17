// Zero-flash Chrome: suppress window show until signal file is removed.
// Signal file: /tmp/.chrome-suppress-<pid>
// When file exists → miniaturize instead of showing
// When file deleted (by Playwright after CDP ready) → pass through
//
// Post-launch hide/show via Unix signals:
//   SIGUSR1 → hide all windows (setAlphaValue:0)
//   SIGUSR2 → show all windows (setAlphaValue:1)
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

static void cloak(NSWindow *w) {
    [w setAlphaValue:0.0];
    [w setFrameOrigin:NSMakePoint(-9999, -9999)];
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
            [w setAlphaValue:1.0];
        }
    });
}

__attribute__((constructor))
static void init(void) {
    // Create signal file immediately
    snprintf(signalPath, sizeof(signalPath), "/tmp/.chrome-suppress-%d", getpid());
    FILE *f = fopen(signalPath, "w");
    if (f) fclose(f);
    initialized = YES;

    // Register signal handlers for post-launch hide/show
    signal(SIGUSR1, handleSIGUSR1);
    signal(SIGUSR2, handleSIGUSR2);

    Class cls = [NSWindow class];
    SEL sels[] = {
        @selector(makeKeyAndOrderFront:),
        @selector(orderFront:),
        @selector(orderFrontRegardless),
    };
    for (int i = 0; i < 3; i++) {
        SEL sel = sels[i];
        Method m = class_getInstanceMethod(cls, sel);
        IMP origIMP = method_getImplementation(m);
        IMP newIMP;
        if (i < 2) {
            newIMP = imp_implementationWithBlock(^(NSWindow *self, id sender) {
                if (shouldSuppress()) {
                    [self miniaturize:nil];
                    return;
                }
                ((void(*)(id, SEL, id))origIMP)(self, sel, sender);
                if (isHidden()) cloak(self);
            });
        } else {
            newIMP = imp_implementationWithBlock(^(NSWindow *self) {
                if (shouldSuppress()) {
                    [self miniaturize:nil];
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
    // live here to catch every path onto the screen.
    {
        SEL sel = @selector(orderWindow:relativeTo:);
        Method m = class_getInstanceMethod(cls, sel);
        IMP origIMP = method_getImplementation(m);
        method_setImplementation(m, imp_implementationWithBlock(
            ^(NSWindow *self, NSWindowOrderingMode place, NSInteger otherWin) {
                ((void(*)(id, SEL, NSWindowOrderingMode, NSInteger))origIMP)(self, sel, place, otherWin);
                if (place != NSWindowOut && isHidden()) cloak(self);
            }));
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
}
