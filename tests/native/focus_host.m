// A minimal foreground application for focus integration tests.
//
// An unattended Mac can have loginwindow as its nominal frontmost process even
// while the window server is compositing normally. In that state, "Chrome did
// not take focus" is vacuous unless the test first establishes a real app that
// can lose focus. This bundle-backed host supplies that baseline.

#import <AppKit/AppKit.h>

@interface FocusHostDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@end

@implementation FocusHostDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    self.window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(40, 40, 320, 180)
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    self.window.title = @"web-plane focus sentinel";
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        FocusHostDelegate *delegate = [[FocusHostDelegate alloc] init];
        NSApp.delegate = delegate;
        [NSApp run];
    }
    return 0;
}
