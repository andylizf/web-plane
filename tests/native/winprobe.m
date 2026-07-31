// winprobe — report what the window server and the Accessibility API actually
// see for one pid, as JSON on stdout.
//
// The tests need an observer that is independent of web-plane's own checks.
// web-plane's verifier and this probe were written from the same understanding
// of macOS, so if the test asked web-plane "did it work?" it would only be
// asking the code under test to grade itself — which is exactly how a window
// sitting in the Dock's minimized tray passed as "shown" for hours.
//
// Two facts matter and neither is available from Chrome:
//   onscreen — kCGWindowIsOnscreen is false for a miniaturized window while its
//              alpha and bounds stay at their pre-minimize values, so alpha and
//              bounds alone cannot tell "visible" from "in the Dock".
//   minimized — the Accessibility API says it outright, but only to a process
//              the user has granted Accessibility rights, so it is reported as
//              unavailable rather than assumed false.
//
// kCGWindowName is deliberately never read: it is the one field that requires
// Screen Recording rights, and no title is needed to answer "is it on screen".
//
// Usage: winprobe <pid>
// Compile: cc -Wall -Werror -framework CoreGraphics -framework CoreFoundation \
//              -framework ApplicationServices -o winprobe winprobe.m

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>

static int intFrom(CFDictionaryRef d, CFStringRef key) {
    CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, key);
    int v = 0;
    if (n) CFNumberGetValue(n, kCFNumberIntType, &v);
    return v;
}

static double doubleFrom(CFDictionaryRef d, CFStringRef key, double fallback) {
    CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, key);
    double v = fallback;
    if (n) CFNumberGetValue(n, kCFNumberDoubleType, &v);
    return v;
}

static int boolFrom(CFDictionaryRef d, CFStringRef key) {
    CFBooleanRef b = (CFBooleanRef)CFDictionaryGetValue(d, key);
    return b && CFBooleanGetValue(b);
}

// Can anything be seen on this machine at all?
//
// A locked screen composites only the lock window: every application window
// reports isOnscreen = false, no matter how correctly it was shown. That reads
// identically to a broken `show`, and — worse — it makes "the window is NOT on
// screen" assertions pass for the wrong reason. Callers check this first.
extern CFDictionaryRef CGSessionCopyCurrentDictionary(void);

static void printSession(void) {
    CFDictionaryRef s = CGSessionCopyCurrentDictionary();
    if (!s) {
        printf("  \"session\": {\"known\": false},\n");
        return;
    }
    printf("  \"session\": {\"known\": true, \"onConsole\": %s, \"screenLocked\": %s},\n",
           boolFrom(s, CFSTR("kCGSSessionOnConsoleKey")) ? "true" : "false",
           boolFrom(s, CFSTR("CGSSessionScreenIsLocked")) ? "true" : "false");
    CFRelease(s);
}

// AXWindows for a pid, or a reason it could not be read. Never guesses: a
// denied query must not look like "this app has no windows".
static void printAX(pid_t pid) {
    printf("  \"ax\": {");
    printf("\"trusted\": %s", AXIsProcessTrusted() ? "true" : "false");

    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) {
        printf(", \"available\": false, \"error\": \"no app element\"}");
        return;
    }
    CFTypeRef windows = NULL;
    AXError err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &windows);
    if (err != kAXErrorSuccess || !windows) {
        printf(", \"available\": false, \"error\": \"AXError %d\"}", (int)err);
        if (windows) CFRelease(windows);
        CFRelease(app);
        return;
    }
    CFArrayRef arr = (CFArrayRef)windows;
    CFIndex n = CFArrayGetCount(arr);
    printf(", \"available\": true, \"count\": %ld, \"windows\": [", (long)n);
    for (CFIndex i = 0; i < n; i++) {
        AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(arr, i);
        CFTypeRef mini = NULL;
        int minimized = -1; // -1 = attribute not readable
        if (AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute, &mini) == kAXErrorSuccess && mini) {
            minimized = CFBooleanGetValue((CFBooleanRef)mini) ? 1 : 0;
            CFRelease(mini);
        }
        printf("%s{\"minimized\": %s}", i ? ", " : "",
               minimized < 0 ? "null" : (minimized ? "true" : "false"));
    }
    printf("]}");
    CFRelease(windows);
    CFRelease(app);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: winprobe <pid>\n");
        return 2;
    }
    pid_t pid = (pid_t)atoi(argv[1]);

    CFArrayRef all = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
    if (!all) {
        fprintf(stderr, "CGWindowListCopyWindowInfo returned NULL\n");
        return 1;
    }
    // Asked separately rather than trusting kCGWindowIsOnscreen alone: the two
    // are answered by different code paths in the window server, and the bug
    // this probe exists for turned on exactly that distinction.
    CFArrayRef onscreen = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);

    // How many windows the compositor has on screen for the whole machine. A
    // sleeping or locked display reports zero for everything, which would
    // otherwise read exactly like "web-plane failed to show the window".
    printf("{\n  \"pid\": %d,\n", (int)pid);
    printSession();
    printf("  \"systemOnScreen\": %ld,\n  \"windows\": [",
           onscreen ? (long)CFArrayGetCount(onscreen) : -1L);
    CFIndex n = CFArrayGetCount(all);
    int printed = 0;
    for (CFIndex i = 0; i < n; i++) {
        CFDictionaryRef info = (CFDictionaryRef)CFArrayGetValueAtIndex(all, i);
        if (intFrom(info, kCGWindowOwnerPID) != pid) continue;

        int number = intFrom(info, kCGWindowNumber);
        CGRect bounds = CGRectZero;
        CFDictionaryRef b = (CFDictionaryRef)CFDictionaryGetValue(info, kCGWindowBounds);
        if (b) CGRectMakeWithDictionaryRepresentation(b, &bounds);

        int inOnScreenList = 0;
        if (onscreen) {
            CFIndex m = CFArrayGetCount(onscreen);
            for (CFIndex j = 0; j < m; j++) {
                CFDictionaryRef o = (CFDictionaryRef)CFArrayGetValueAtIndex(onscreen, j);
                if (intFrom(o, kCGWindowNumber) == number) { inOnScreenList = 1; break; }
            }
        }

        printf("%s\n    {\"number\": %d, \"alpha\": %g, \"layer\": %d, "
               "\"x\": %g, \"y\": %g, \"w\": %g, \"h\": %g, "
               "\"isOnscreenFlag\": %s, \"inOnScreenList\": %s}",
               printed ? "," : "", number,
               doubleFrom(info, kCGWindowAlpha, -1.0), intFrom(info, kCGWindowLayer),
               bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height,
               boolFrom(info, kCGWindowIsOnscreen) ? "true" : "false",
               inOnScreenList ? "true" : "false");
        printed++;
    }
    printf("%s],\n", printed ? "\n  " : "");
    printAX(pid);
    printf("\n}\n");

    CFRelease(all);
    if (onscreen) CFRelease(onscreen);
    return 0;
}
