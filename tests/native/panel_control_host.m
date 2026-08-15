#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <limits.h>
#include <unistd.h>

static NSString *jsonString(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSString *safeAccessibilityString(id object, SEL selector) {
    @try {
        if (![object respondsToSelector:selector]) return @"";
        id value = [object performSelector:selector];
        if ([value isKindOfClass:[NSURL class]]) return [(NSURL *)value path] ?: @"";
        return [value isKindOfClass:[NSString class]] ? value : ([value description] ?: @"");
    } @catch (__unused NSException *exception) {
        return @"<exception>";
    }
}

static void dumpElement(id element, NSInteger depth, NSHashTable *seen) {
    if (!element || depth > 12 || [seen containsObject:element]) return;
    [seen addObject:element];
    NSString *indent = [@"  " stringByPaddingToLength:(NSUInteger)(depth * 2)
                                             withString:@"  "
                                        startingAtIndex:0];
    fprintf(stderr, "%sclass=%s role=%s id=%s title=%s label=%s value=%s filename=%s url=%s\n",
            [indent UTF8String],
            [NSStringFromClass([element class]) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityRole)) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityIdentifier)) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityTitle)) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityLabel)) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityValue)) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityFilename)) UTF8String],
            [safeAccessibilityString(element, @selector(accessibilityURL)) UTF8String]);
    @try {
        if ([element respondsToSelector:@selector(accessibilityChildren)]) {
            for (id child in [element accessibilityChildren]) dumpElement(child, depth + 1, seen);
        }
    } @catch (__unused NSException *exception) {}
}

static NSNumber *windowServerAlpha(NSInteger windowNumber) {
    if (windowNumber <= 0) return nil;
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
    NSNumber *alpha = nil;
    for (NSDictionary *entry in (__bridge NSArray *)list) {
        if ([entry[(id)kCGWindowNumber] integerValue] == windowNumber) {
            alpha = entry[(id)kCGWindowAlpha];
            break;
        }
    }
    if (list) CFRelease(list);
    return alpha;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) {
            fprintf(stderr, "usage: panel_control_host <save|open> <initial-directory>\n");
            return 2;
        }
        NSString *kind = [NSString stringWithUTF8String:argv[1]];
        NSString *initialDirectory = [NSString stringWithUTF8String:argv[2]];
        if (![kind isEqualToString:@"save"] && ![kind isEqualToString:@"open"]) {
            fprintf(stderr, "unknown panel kind\n");
            return 2;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        if (getenv("WEB_PLANE_START_VISIBLE")) {
            const char *runDir = getenv("WEB_PLANE_RUN_DIR");
            const char *runId = getenv("WEB_PLANE_RUN_ID");
            if (runDir && runId) {
                char hiddenPath[PATH_MAX];
                snprintf(hiddenPath, sizeof(hiddenPath), "%s/.chrome-hidden-%s", runDir, runId);
                unlink(hiddenPath);
            }
        }

        NSSavePanel *panel = nil;
        if ([kind isEqualToString:@"open"]) {
            NSOpenPanel *open = [NSOpenPanel openPanel];
            [open setCanChooseFiles:YES];
            [open setCanChooseDirectories:YES];
            [open setAllowsMultipleSelection:NO];
            panel = open;
        } else {
            panel = [NSSavePanel savePanel];
            [panel setNameFieldStringValue:@"initial-name.txt"];
        }
        [panel setDirectoryURL:[NSURL fileURLWithPath:initialDirectory isDirectory:YES]];

        __block BOOL done = NO;
        __block NSModalResponse result = NSModalResponseAbort;
        __block BOOL becameActive = NO;
        __block BOOL sampledVisiblePanel = NO;
        __block CGFloat maxAppKitAlpha = 0.0;
        __block CGFloat maxWindowServerAlpha = 0.0;
        void (^sample)(void) = ^{
            if ([[NSRunningApplication currentApplication] isActive]) becameActive = YES;
            if ([panel isVisible]) {
                sampledVisiblePanel = YES;
                maxAppKitAlpha = MAX(maxAppKitAlpha, [panel alphaValue]);
                NSNumber *serverAlpha = windowServerAlpha([panel windowNumber]);
                if (serverAlpha) maxWindowServerAlpha = MAX(maxWindowServerAlpha, [serverAlpha doubleValue]);
            }
        };
        [panel beginWithCompletionHandler:^(NSModalResponse response) {
            result = response;
            done = YES;
        }];
        if (getenv("WEB_PLANE_DUMP_PANEL")) {
            NSDate *readyAt = [NSDate dateWithTimeIntervalSinceNow:0.3];
            while ([readyAt timeIntervalSinceNow] > 0) {
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                          beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
            }
            NSHashTable *seen = [NSHashTable hashTableWithOptions:NSPointerFunctionsObjectPointerPersonality];
            for (NSWindow *window in [NSApp windows]) {
                fprintf(stderr, "WINDOW class=%s number=%ld visible=%d title=%s\n",
                        [NSStringFromClass([window class]) UTF8String],
                        (long)[window windowNumber], [window isVisible], [[window title] UTF8String]);
                dumpElement(window, 0, seen);
            }
            fflush(stderr);
        }
        printf("%s\n", [jsonString(@{
            @"event": @"ready",
            @"pid": @(getpid()),
            @"windowNumber": @([panel windowNumber]),
        }) UTF8String]);
        fflush(stdout);

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
        while (!done && [deadline timeIntervalSinceNow] > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
            sample();
        }

        // The injected bridge verifies dismissal on its next main-queue turn
        // before writing the response. A real Chrome process stays alive; this
        // tiny host must do the same briefly or it can exit after AppKit's
        // completion handler but before the verified response reaches the CLI.
        NSDate *settled = [NSDate dateWithTimeIntervalSinceNow:0.4];
        while ([settled timeIntervalSinceNow] > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
            sample();
        }

        NSString *url = [[panel URL] path];
        printf("%s\n", [jsonString(@{
            @"event": @"complete",
            @"done": @(done),
            @"result": @(result),
            @"url": url ?: [NSNull null],
            @"visible": @([panel isVisible]),
            @"sampledVisiblePanel": @(sampledVisiblePanel),
            @"maxAppKitAlpha": @(maxAppKitAlpha),
            @"maxWindowServerAlpha": @(maxWindowServerAlpha),
            @"becameActive": @(becameActive),
        }) UTF8String]);
        fflush(stdout);
        return done ? 0 : 3;
    }
}
