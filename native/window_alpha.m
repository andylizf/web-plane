// window_alpha.m — Set Chrome window alpha via CoreGraphics private API
// Usage: window_alpha <0|1> [pid]
//   0 = hide (fully transparent, still renders → screenshots work)
//   1 = show (fully opaque)
// Compile: cc -framework CoreGraphics -framework CoreFoundation -o window_alpha window_alpha.m

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Private CG API
typedef int CGSConnectionID;
extern CGSConnectionID CGSMainConnectionID(void);
extern CGError CGSSetWindowAlpha(CGSConnectionID cid, CGWindowID wid, float alpha);

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: window_alpha <0|1> [pid]\n");
        return 1;
    }

    float alpha = atof(argv[1]);
    pid_t targetPid = argc >= 3 ? atoi(argv[2]) : 0;

    CGSConnectionID cid = CGSMainConnectionID();
    if (!cid) {
        fprintf(stderr, "Failed to get CGS connection\n");
        return 1;
    }

    // Get all windows (including off-screen / hidden)
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll,
        kCGNullWindowID
    );

    if (!windowList) {
        fprintf(stderr, "Failed to get window list\n");
        return 1;
    }

    int count = 0;
    CFIndex n = CFArrayGetCount(windowList);
    for (CFIndex i = 0; i < n; i++) {
        CFDictionaryRef info = CFArrayGetValueAtIndex(windowList, i);

        // Get owner PID
        CFNumberRef pidRef = CFDictionaryGetValue(info, kCGWindowOwnerPID);
        pid_t pid = 0;
        if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &pid);

        // Get owner name
        CFStringRef nameRef = CFDictionaryGetValue(info, kCGWindowOwnerName);
        char name[256] = "";
        if (nameRef) CFStringGetCString(nameRef, name, sizeof(name), kCFStringEncodingUTF8);

        // Filter: match pid if given, otherwise match "Google Chrome"
        if (targetPid > 0) {
            if (pid != targetPid) continue;
        } else {
            if (strcmp(name, "Google Chrome") != 0) continue;
        }

        // Get window ID
        CFNumberRef widRef = CFDictionaryGetValue(info, kCGWindowNumber);
        CGWindowID wid = 0;
        if (widRef) CFNumberGetValue(widRef, kCFNumberIntType, &wid);

        if (wid > 0) {
            CGError err = CGSSetWindowAlpha(cid, wid, alpha);
            if (err == kCGErrorSuccess) {
                count++;
            } else {
                fprintf(stderr, "CGSSetWindowAlpha failed for window %d: error %d\n", wid, err);
            }
        }
    }

    CFRelease(windowList);

    if (count == 0) {
        fprintf(stderr, "No matching windows found\n");
        return 1;
    }

    printf("%d window(s) set to alpha %.1f\n", count, alpha);
    return 0;
}
