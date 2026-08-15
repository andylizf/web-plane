#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <limits.h>
#include <signal.h>
#include <unistd.h>

// Chromium uses this exact subclass for browser frames. The injected hook looks
// it up at runtime, so this host can exercise the same boundary without Chrome.
@interface BrowserNativeWidgetWindow : NSWindow
@end
@implementation BrowserNativeWidgetWindow
@end

// Chromium uses this separate family for its own keyable bubbles, including
// restore/error UI and recent-download history. They are not system panels and
// must stay cloaked with the browser frame while the session is hidden.
@interface NativeWidgetMacNSWindow : NSWindow
@end
@implementation NativeWidgetMacNSWindow
@end

static NSDictionary *serverInfo(NSInteger windowNumber) {
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    NSDictionary *found = nil;
    for (NSDictionary *entry in (__bridge NSArray *)list) {
        if ([entry[(id)kCGWindowNumber] integerValue] == windowNumber) {
            found = [entry copy];
            break;
        }
    }
    if (list) CFRelease(list);
    return found;
}

static void pumpRunLoop(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while ([until timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                  beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
}

static void clearHiddenFlag(void) {
    const char *runDir = getenv("WEB_PLANE_RUN_DIR");
    const char *runId = getenv("WEB_PLANE_RUN_ID");
    if (!runDir || !runId) return;
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/.chrome-hidden-%s", runDir, runId);
    unlink(path);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        // This launch-time request must remain blocked. A native panel below is
        // the event that should temporarily lift the activation guard.
        [NSApp activateIgnoringOtherApps:YES];
        BrowserNativeWidgetWindow *browser = [[BrowserNativeWidgetWindow alloc]
            initWithContentRect:NSMakeRect(120, 140, 900, 700)
                      styleMask:NSWindowStyleMaskTitled
                        backing:NSBackingStoreBuffered
                          defer:NO];
        NSPanel *panel = [[NSPanel alloc]
            initWithContentRect:NSMakeRect(260, 280, 520, 360)
                      styleMask:NSWindowStyleMaskTitled
                        backing:NSBackingStoreBuffered
                          defer:NO];
        [panel setHidesOnDeactivate:NO];
        NSPanel *sheet = [[NSPanel alloc]
            initWithContentRect:NSMakeRect(0, 0, 480, 240)
                      styleMask:NSWindowStyleMaskTitled
                        backing:NSBackingStoreBuffered
                          defer:NO];
        [sheet setHidesOnDeactivate:NO];
        NativeWidgetMacNSWindow *recover = [[NativeWidgetMacNSWindow alloc]
            initWithContentRect:NSMakeRect(740, 620, 320, 88)
                      styleMask:NSWindowStyleMaskBorderless
                        backing:NSBackingStoreBuffered
                          defer:NO];
        [recover setTitle:@"Restore Pages"];

        [browser orderFront:nil];
        [panel makeKeyAndOrderFront:nil];
        [browser beginSheet:sheet completionHandler:nil];
        pumpRunLoop(0.4);

        NSPoint browserOrigin = [browser frame].origin;
        NSPoint panelOrigin = [panel frame].origin;
        NSPoint sheetOrigin = [sheet frame].origin;
        printf("{\"browserAlpha\":%.0f,\"browserX\":%.0f,"
               "\"browserIgnoresMouse\":%s,"
               "\"panelAlpha\":%.0f,\"panelX\":%.0f,"
               "\"sheetAlpha\":%.0f,\"sheetX\":%.0f,"
               "\"sheetVisible\":%s,\"panelOnScreen\":%s,"
               "\"sheetOnScreen\":%s,\"humanUIActive\":%s,",
               [browser alphaValue], browserOrigin.x,
               [browser ignoresMouseEvents] ? "true" : "false",
               [panel alphaValue], panelOrigin.x,
               [sheet alphaValue], sheetOrigin.x,
               [sheet isVisible] ? "true" : "false",
               serverInfo([panel windowNumber]) ? "true" : "false",
               serverInfo([sheet windowNumber]) ? "true" : "false",
               [[NSRunningApplication currentApplication] isActive] ? "true" : "false");
        fflush(stdout);

        [browser endSheet:sheet];
        [sheet close];
        [panel close];
        pumpRunLoop(0.4);
        BOOL activeAfterClose = [[NSRunningApplication currentApplication] isActive];

        // Reproduce the real post-Cancel failure: Chrome orders a keyable
        // Recover/download bubble after the system panel goes away. It must not
        // re-activate the app and it must remain transparent/click-through.
        [recover makeKeyAndOrderFront:nil];
        pumpRunLoop(0.4);
        BOOL activeAfterRecover = [[NSRunningApplication currentApplication] isActive];
        CGFloat recoverAlpha = [recover alphaValue];
        BOOL recoverIgnoresMouse = [recover ignoresMouseEvents];
        clearHiddenFlag();
        raise(SIGUSR2);
        pumpRunLoop(0.8);
        printf("\"activeAfterClose\":%s,\"recoverAlpha\":%.0f,"
               "\"recoverIgnoresMouse\":%s,"
               "\"activeAfterRecover\":%s,\"browserAlphaAfterShow\":%.0f,"
               "\"browserIgnoresMouseAfterShow\":%s,"
               "\"recoverAlphaAfterShow\":%.0f,"
               "\"recoverIgnoresMouseAfterShow\":%s}\n",
               activeAfterClose ? "true" : "false",
               recoverAlpha,
               recoverIgnoresMouse ? "true" : "false",
               activeAfterRecover ? "true" : "false",
               [browser alphaValue],
               [browser ignoresMouseEvents] ? "true" : "false",
               [recover alphaValue],
               [recover ignoresMouseEvents] ? "true" : "false");
        [recover close];
        [browser close];
        return 0;
    }
}
