#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <string.h>

@interface NativeWidgetMacNSWindow : NSWindow
@end
@implementation NativeWidgetMacNSWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end

@interface BrowserNativeWidgetWindow : NativeWidgetMacNSWindow
@end
@implementation BrowserNativeWidgetWindow
@end

@interface ModalAwareBrowserWindow : BrowserNativeWidgetWindow
@property(assign) NSWindow *modalChild;
@end
@implementation ModalAwareBrowserWindow
@synthesize modalChild = _modalChild;
- (NSWindow *)topmostVisibleChildModalWindow { return _modalChild; }
@end

static NSString *jsonString(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2 || (strcmp(argv[1], "modal") != 0 &&
                          strcmp(argv[1], "popover") != 0 &&
                          strcmp(argv[1], "anchored-bubble") != 0 &&
                          strcmp(argv[1], "mixed") != 0 &&
                          strcmp(argv[1], "legacy-modal") != 0 &&
                          strcmp(argv[1], "native-panel") != 0)) {
            fprintf(stderr, "usage: ui_blocker_host <modal|popover|anchored-bubble|mixed|legacy-modal|native-panel>\n");
            return 2;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];

        Class browserClass = strcmp(argv[1], "legacy-modal") == 0
            ? [BrowserNativeWidgetWindow class] : [ModalAwareBrowserWindow class];
        BrowserNativeWidgetWindow *browser = [[browserClass alloc]
            initWithContentRect:NSMakeRect(120, 140, 900, 700)
                      styleMask:NSWindowStyleMaskTitled
                        backing:NSBackingStoreBuffered
                          defer:NO];
        NSWindow *surface = nil;
        if (strcmp(argv[1], "native-panel") == 0) {
            surface = [[NSPanel alloc]
                initWithContentRect:NSMakeRect(320, 300, 448, 300)
                          styleMask:NSWindowStyleMaskTitled
                            backing:NSBackingStoreBuffered
                              defer:NO];
        } else {
            surface = [[NativeWidgetMacNSWindow alloc]
                initWithContentRect:NSMakeRect(320, 300, 448, 300)
                          styleMask:NSWindowStyleMaskBorderless
                            backing:NSBackingStoreBuffered
                              defer:NO];
        }
        [surface setTitle:@"Arbitrary browser-owned UI"];
        if (strcmp(argv[1], "modal") == 0 || strcmp(argv[1], "legacy-modal") == 0 ||
            strcmp(argv[1], "anchored-bubble") == 0 || strcmp(argv[1], "mixed") == 0) {
            [browser addChildWindow:surface ordered:NSWindowAbove];
        }
        if (strcmp(argv[1], "modal") == 0) {
            [(ModalAwareBrowserWindow *)browser setModalChild:surface];
        }
        if (strcmp(argv[1], "mixed") == 0) {
            NativeWidgetMacNSWindow *modal = [[NativeWidgetMacNSWindow alloc]
                initWithContentRect:NSMakeRect(400, 350, 448, 300)
                          styleMask:NSWindowStyleMaskBorderless
                            backing:NSBackingStoreBuffered
                              defer:NO];
            // A modal with a bubble's title must still gate input.
            [modal setTitle:@"Recent Download History"];
            [browser addChildWindow:modal ordered:NSWindowAbove];
            [(ModalAwareBrowserWindow *)browser setModalChild:modal];
            [modal orderFront:nil];
        }
        [browser orderFront:nil];
        [surface makeKeyAndOrderFront:nil];

        NSDate *readyAt = [NSDate dateWithTimeIntervalSinceNow:0.2];
        while ([readyAt timeIntervalSinceNow] > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        }
        printf("%s\n", [jsonString(@{
            @"event": @"ready",
            @"pid": @(getpid()),
            @"surfaceWindow": @([surface windowNumber]),
        }) UTF8String]);
        fflush(stdout);

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10.0];
        while ([deadline timeIntervalSinceNow] > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        }
        [surface close];
        [browser close];
        return 0;
    }
}
