#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

// Chromium uses this exact subclass for browser frames. The injected hook looks
// it up at runtime, so this host can exercise the same boundary without Chrome.
@interface BrowserNativeWidgetWindow : NSWindow
@end
@implementation BrowserNativeWidgetWindow
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
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

        [browser orderFront:nil];
        [panel makeKeyAndOrderFront:nil];

        NSPoint browserOrigin = [browser frame].origin;
        NSPoint panelOrigin = [panel frame].origin;
        printf("{\"browserAlpha\":%.0f,\"browserX\":%.0f,"
               "\"panelAlpha\":%.0f,\"panelX\":%.0f}\n",
               [browser alphaValue], browserOrigin.x,
               [panel alphaValue], panelOrigin.x);
        [panel close];
        [browser close];
        return 0;
    }
}
