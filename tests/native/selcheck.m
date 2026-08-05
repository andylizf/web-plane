// selcheck — does the private AppKit method the focus fix depends on still exist,
// with the signature the hook calls through?
//
// window_suppress.m stops focus theft by swizzling
// -[NSApplication _activateWithInfo:]. That is where AppKit's window-restoration
// pass reaches SkyLight, and no public API sits on that path — hooks on
// activateIgnoringOtherApps:, activate, and NSRunningApplication's activation
// methods were all measured and all missed it.
//
// Being private, it can be renamed or reshaped by any macOS update. The dylib
// handles that safely: it looks the selector up by name and installs the hook
// only if the type encoding still matches, so a change degrades to the slower
// focus hand-back rather than corrupting the stack. Safe, but silent — the
// symptom would be focus theft quietly coming back, and the last time that
// happened it took a full debugging session to notice it was even a bug.
//
// So assert it here instead, where CI can see it. A red build on a new macOS is
// the cheapest possible warning.
//
// Compile: cc -Wall -Werror -framework AppKit -framework Foundation \
//              -o selcheck tests/native/selcheck.m
// Exit 0 = the hook will install; 1 = it will fall back (with the reason on stdout).

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <string.h>

// void return, self, _cmd, one object argument. The hook calls the original
// through a function pointer of exactly this shape.
static const char *kExpected = "v24@0:8@16";

int main(void) {
    @autoreleasepool {
        int failures = 0;

        SEL sel = NSSelectorFromString(@"_activateWithInfo:");
        Method m = class_getInstanceMethod([NSApplication class], sel);
        if (!m) {
            printf("FAIL -[NSApplication _activateWithInfo:] is gone — the focus "
                   "fix has silently degraded to the hand-back fallback\n");
            failures++;
        } else {
            const char *types = method_getTypeEncoding(m);
            if (strcmp(types, kExpected) != 0) {
                printf("FAIL -[NSApplication _activateWithInfo:] changed shape: "
                       "expected %s, got %s — the hook declines to install\n",
                       kExpected, types);
                failures++;
            } else {
                printf("ok   -[NSApplication _activateWithInfo:] present, types=%s\n", types);
            }
        }

        // The public hooks are the fallback layer. They are not sufficient on
        // their own (measured: 6180ms of stolen focus down to 2233ms, never to
        // zero), but if they disappeared too there would be nothing left, so
        // their absence should also be loud.
        struct { Class cls; const char *name; } fallbacks[] = {
            { [NSApplication class],       "activateIgnoringOtherApps:" },
            { [NSApplication class],       "activate" },
            { [NSRunningApplication class], "activateWithOptions:" },
        };
        for (size_t i = 0; i < sizeof(fallbacks) / sizeof(fallbacks[0]); i++) {
            SEL s = NSSelectorFromString([NSString stringWithUTF8String:fallbacks[i].name]);
            if (!class_getInstanceMethod(fallbacks[i].cls, s)) {
                printf("FAIL fallback hook target %s is gone\n", fallbacks[i].name);
                failures++;
            } else {
                printf("ok   fallback %s present\n", fallbacks[i].name);
            }
        }

        // Activation policy is deliberately never set (Accessory does not gate
        // this path; Prohibited kills the browser on real pages). If a future
        // reader is tempted to reach for it again, the transitions are at least
        // recorded here as what the OS actually allows today.
        [NSApplication sharedApplication];
        NSApplicationActivationPolicy start = [NSApp activationPolicy];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        BOOL toAccessory = [NSApp activationPolicy] == NSApplicationActivationPolicyAccessory;
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        BOOL backToRegular = [NSApp activationPolicy] == NSApplicationActivationPolicyRegular;
        [NSApp setActivationPolicy:start];
        printf("note activation policy transitions: ->Accessory %s, ->Regular %s\n",
               toAccessory ? "allowed" : "REFUSED", backToRegular ? "allowed" : "REFUSED");

        if (failures) {
            printf("\n%d check(s) failed — see native/window_suppress.m and "
                   "docs/window-and-focus.md\n", failures);
            return 1;
        }
        printf("\nall activation hook targets intact\n");
        return 0;
    }
}
