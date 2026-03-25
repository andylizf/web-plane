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
static BOOL initialized = NO;

static BOOL shouldSuppress(void) {
    if (!initialized) {
        snprintf(signalPath, sizeof(signalPath), "/tmp/.chrome-suppress-%d", getpid());
        initialized = YES;
    }
    return access(signalPath, F_OK) == 0;
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
            });
        } else {
            newIMP = imp_implementationWithBlock(^(NSWindow *self) {
                if (shouldSuppress()) {
                    [self miniaturize:nil];
                    return;
                }
                ((void(*)(id, SEL))origIMP)(self, sel);
            });
        }
        method_setImplementation(m, newIMP);
    }
    // Block activation while suppressing
    {
        Class appCls = [NSApplication class];
        SEL sel = @selector(activateIgnoringOtherApps:);
        Method m = class_getInstanceMethod(appCls, sel);
        IMP origIMP = method_getImplementation(m);
        method_setImplementation(m, imp_implementationWithBlock(^(NSApplication *self, BOOL flag) {
            if (shouldSuppress()) return;
            ((void(*)(id, SEL, BOOL))origIMP)(self, sel, flag);
        }));
    }
}
