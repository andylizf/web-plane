// Typed control for AppKit Save/Open panels owned by the injected process.
//
// On current macOS the visible file browser is remote AppKit UI: Chrome owns an
// NSSavePanel proxy whose only accessibility child is NSAccessibilityRemoteUIElement.
// Once that proxy is running, public path setters no longer change its selection.
// Therefore a hidden web-plane session intercepts async presentation while the
// panel is still configurable. The agent supplies an exact path (or cancels),
// and the original completion handler receives the matching modal result without
// showing UI. If nobody responds within 30 seconds, presentation proceeds
// normally so automation failure never removes the human fallback.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <signal.h>
#include <unistd.h>

static const NSInteger kPanelProtocol = 1;
static const NSTimeInterval kRequestMaxAgeMs = 10000.0;
static const NSTimeInterval kPendingFallbackSeconds = 30.0;
static NSString *gRunDir = nil;
static NSString *gRunId = nil;
static NSString *gHiddenPath = nil;
static NSString *gAutomationPath = nil;

typedef NS_ENUM(NSInteger, PendingPresentation) {
    PendingNone = 0,
    PendingModeless = 1,
    PendingSheet = 2,
};

static PendingPresentation gPendingMode = PendingNone;
static NSSavePanel *gPendingPanel = nil;
static NSWindow *gPendingParent = nil;
static void (^gPendingCompletion)(NSModalResponse) = nil;
static NSString *gPendingId = nil;
static BOOL gPendingPresentedForAutomation = NO;
static BOOL gPendingForceOK = NO;
static IMP gOriginalBegin = NULL;
static IMP gOriginalBeginSheet = NULL;

static BOOL isPanelBrowserProcess(void) {
    for (NSString *arg in [[NSProcessInfo processInfo] arguments]) {
        if ([arg hasPrefix:@"--type="]) return NO;
    }
    return YES;
}

static BOOL sessionIsHidden(void) {
    return gHiddenPath && [[NSFileManager defaultManager] fileExistsAtPath:gHiddenPath];
}

static NSDictionary *panelError(NSString *requestId, NSString *code, NSString *message) {
    return @{
        @"protocol": @(kPanelProtocol),
        @"id": requestId ?: @"",
        @"ok": @NO,
        @"error": @{ @"code": code, @"message": message },
    };
}

static NSDictionary *panelSuccess(NSString *requestId, NSDictionary *fields) {
    NSMutableDictionary *response = [[@{
        @"protocol": @(kPanelProtocol),
        @"id": requestId ?: @"",
        @"ok": @YES,
    } mutableCopy] autorelease];
    if (fields) [response addEntriesFromDictionary:fields];
    return response;
}

static void writeResponse(NSString *path, NSDictionary *response) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    if (data) [data writeToFile:path options:NSDataWritingAtomic error:nil];
}

static NSSavePanel *activeVisiblePanel(void) {
    for (NSWindow *window in [NSApp windows]) {
        if ([window isVisible] && [window isKindOfClass:[NSSavePanel class]]) {
            return (NSSavePanel *)window;
        }
    }
    return nil;
}

static NSPanel *unsupportedNativePanel(void) {
    for (NSWindow *window in [NSApp windows]) {
        if (![window isVisible] || [window isKindOfClass:[NSSavePanel class]]) continue;
        if ([window isKindOfClass:[NSPanel class]] && [window canBecomeKeyWindow]) {
            return (NSPanel *)window;
        }
    }
    return nil;
}

static NSString *standardPath(NSString *path) {
    return [[path stringByStandardizingPath] stringByResolvingSymlinksInPath];
}

static NSDictionary *stateForPanel(NSSavePanel *panel, NSString *panelId, BOOL pending) {
    BOOL open = [panel isKindOfClass:[NSOpenPanel class]];
    NSString *directory = [[panel directoryURL] path];
    NSString *url = [[panel URL] path];
    return @{
        @"id": panelId,
        @"kind": open ? @"open" : @"save",
        @"title": [panel title] ?: @"",
        @"prompt": [panel prompt] ?: @"",
        @"directory": directory ?: [NSNull null],
        @"name": open ? [NSNull null] : ([panel nameFieldStringValue] ?: @""),
        @"url": url ?: [NSNull null],
        @"sheet": @(pending ? gPendingMode == PendingSheet : [panel sheetParent] != nil),
        @"pending": @(pending),
    };
}

static NSDictionary *currentPanelState(void) {
    if (gPendingPanel) return stateForPanel(gPendingPanel, gPendingId, YES);
    NSSavePanel *panel = activeVisiblePanel();
    if (!panel) return nil;
    NSString *panelId = [NSString stringWithFormat:@"%ld", (long)[panel windowNumber]];
    return stateForPanel(panel, panelId, NO);
}

static void clearPending(void) {
    if (gAutomationPath) [[NSFileManager defaultManager] removeItemAtPath:gAutomationPath error:nil];
    [gPendingPanel release];
    [gPendingParent release];
    [gPendingCompletion release];
    [gPendingId release];
    gPendingPanel = nil;
    gPendingParent = nil;
    gPendingCompletion = nil;
    gPendingId = nil;
    gPendingMode = PendingNone;
    gPendingPresentedForAutomation = NO;
    gPendingForceOK = NO;
}

static void presentPendingFallback(void) {
    if (!gPendingPanel) return;
    NSSavePanel *panel = [gPendingPanel retain];
    NSWindow *parent = [gPendingParent retain];
    void (^completion)(NSModalResponse) = [gPendingCompletion copy];
    PendingPresentation mode = gPendingMode;
    clearPending();
    if (mode == PendingSheet) {
        ((void(*)(id, SEL, NSWindow *, void (^)(NSModalResponse)))gOriginalBeginSheet)(
            panel, @selector(beginSheetModalForWindow:completionHandler:), parent, completion);
    } else {
        ((void(*)(id, SEL, void (^)(NSModalResponse)))gOriginalBegin)(
            panel, @selector(beginWithCompletionHandler:), completion);
    }
    [completion release];
    [parent release];
    [panel release];
}

static void checkPendingFallback(NSString *capturedId, NSTimeInterval deadline) {
    if (!gPendingId || ![gPendingId isEqualToString:capturedId]) return;
    if (!sessionIsHidden() || [[NSDate date] timeIntervalSince1970] >= deadline) {
        presentPendingFallback();
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        checkPendingFallback(capturedId, deadline);
    });
}

static void forwardPresentedCompletion(NSModalResponse result) {
    void (^completion)(NSModalResponse) = [gPendingCompletion copy];
    NSModalResponse forwarded = gPendingForceOK ? NSModalResponseOK : result;
    clearPending();
    completion(forwarded);
    [completion release];
}

static BOOL presentPendingForAutomation(void) {
    if (!gPendingPanel) return NO;
    if (gPendingPresentedForAutomation) return YES;
    if (![@"open-panel-initialization\n" writeToFile:gAutomationPath
                                              atomically:YES
                                                encoding:NSUTF8StringEncoding
                                                   error:nil]) {
        return NO;
    }
    gPendingPresentedForAutomation = YES;
    void (^completion)(NSModalResponse) = ^(NSModalResponse result) {
        forwardPresentedCompletion(result);
    };
    if (gPendingMode == PendingSheet) {
        ((void(*)(id, SEL, NSWindow *, void (^)(NSModalResponse)))gOriginalBeginSheet)(
            gPendingPanel, @selector(beginSheetModalForWindow:completionHandler:),
            gPendingParent, completion);
    } else {
        ((void(*)(id, SEL, void (^)(NSModalResponse)))gOriginalBegin)(
            gPendingPanel, @selector(beginWithCompletionHandler:), completion);
    }
    return YES;
}

static BOOL capturePending(
    NSSavePanel *panel,
    PendingPresentation mode,
    NSWindow *parent,
    void (^completion)(NSModalResponse)
) {
    if (!sessionIsHidden() || gPendingPanel || !completion) return NO;
    gPendingMode = mode;
    gPendingPanel = [panel retain];
    gPendingParent = [parent retain];
    gPendingCompletion = [completion copy];
    gPendingId = [[[NSUUID UUID] UUIDString] copy];

    NSString *capturedId = [gPendingId copy];
    NSTimeInterval deadline = [[NSDate date] timeIntervalSince1970] + kPendingFallbackSeconds;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        checkPendingFallback(capturedId, deadline);
    });
    [capturedId release];
    return YES;
}

static BOOL pendingMatches(NSString *panelId) {
    return gPendingPanel && [panelId isKindOfClass:[NSString class]] &&
           [gPendingId isEqualToString:panelId];
}

static BOOL activeMatches(NSSavePanel *panel, NSString *panelId) {
    if (!panel || ![panel isVisible] || ![panelId isKindOfClass:[NSString class]]) return NO;
    return [[NSString stringWithFormat:@"%ld", (long)[panel windowNumber]] isEqualToString:panelId];
}

static NSDictionary *configurePendingPath(NSString *requestId, NSString *path) {
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL open = [gPendingPanel isKindOfClass:[NSOpenPanel class]];
    BOOL isDirectory = NO;

    if (open) {
        if (![fm fileExistsAtPath:path isDirectory:&isDirectory]) {
            return panelError(requestId, @"PATH_NOT_FOUND",
                              [NSString stringWithFormat:@"open target does not exist: %@", path]);
        }
        NSOpenPanel *panel = (NSOpenPanel *)gPendingPanel;
        if ((isDirectory && ![panel canChooseDirectories]) ||
            (!isDirectory && ![panel canChooseFiles])) {
            return panelError(requestId, @"PATH_NOT_ALLOWED",
                              [NSString stringWithFormat:@"Open panel does not allow this target: %@", path]);
        }
        [panel setDirectoryURL:[NSURL fileURLWithPath:path isDirectory:isDirectory]];
    } else {
        NSString *parent = [path stringByDeletingLastPathComponent];
        BOOL parentIsDirectory = NO;
        if (![fm fileExistsAtPath:parent isDirectory:&parentIsDirectory] || !parentIsDirectory) {
            return panelError(requestId, @"PARENT_NOT_FOUND",
                              [NSString stringWithFormat:@"save directory does not exist: %@", parent]);
        }
        if ([fm fileExistsAtPath:path]) {
            return panelError(requestId, @"TARGET_EXISTS",
                              [NSString stringWithFormat:@"refusing to overwrite existing path: %@", path]);
        }
        [gPendingPanel setDirectoryURL:[NSURL fileURLWithPath:parent isDirectory:YES]];
        [gPendingPanel setNameFieldStringValue:[path lastPathComponent]];
    }

    return nil;
}

static void completePending(NSModalResponse result) {
    void (^completion)(NSModalResponse) = [gPendingCompletion copy];
    clearPending();
    completion(result);
    [completion release];
}

static void dismissPreparedOpenPanel(
    NSString *requestId,
    NSString *responsePath,
    NSString *path,
    NSString *panelId
) {
    if (!pendingMatches(panelId)) {
        writeResponse(responsePath, panelError(requestId, @"PANEL_CHANGED",
                                               @"Open panel changed before dismissal"));
        return;
    }
    NSSavePanel *panel = [gPendingPanel retain];
    @try {
        // NSSavePanel's public ok: is a stub on the modern remote proxy,
        // and it exposes no local default button. Once URL is exact, use
        // the supported Cancel path to tear down the remote service while
        // translating its completion to OK for the caller.
        gPendingForceOK = YES;
        [panel cancel:nil];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC),
                       dispatch_get_main_queue(), ^{
            if (!pendingMatches(panelId)) {
                writeResponse(responsePath, panelSuccess(requestId, @{
                    @"action": @"accept", @"path": path, @"dismissed": @YES,
                    @"interceptedBeforeDisplay": @YES,
                }));
            } else {
                writeResponse(responsePath, panelError(
                    requestId, @"ACTION_NOT_DISMISSED",
                    @"Open panel stayed open after its internal dismissal"));
                @try { [gPendingPanel cancel:nil]; }
                @catch (__unused NSException *cancelException) {}
            }
        });
    } @catch (NSException *exception) {
        writeResponse(responsePath, panelError(
            requestId, @"ACTION_REJECTED",
            [NSString stringWithFormat:@"Open panel rejected its internal dismissal: %@",
                                       [exception reason]]));
        @try { [panel cancel:nil]; } @catch (__unused NSException *cancelException) {}
    }
    [panel release];
}

static void acceptPendingWhenApplied(
    NSString *requestId,
    NSString *responsePath,
    NSString *path,
    NSString *panelId,
    NSInteger attempt
) {
    if (!pendingMatches(panelId)) {
        writeResponse(responsePath, panelError(requestId, @"PANEL_CHANGED",
                                               @"pending panel changed while applying the path"));
        return;
    }
    NSString *selected = standardPath([[gPendingPanel URL] path]);
    if ([selected isEqualToString:standardPath(path)]) {
        if (gPendingPresentedForAutomation) {
            // Give the remote service two compositor frames to finish ordering.
            // The lifecycle test samples this interval independently, proving the
            // automation marker keeps it alpha-zero and non-activating.
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                           dispatch_get_main_queue(), ^{
                dismissPreparedOpenPanel(requestId, responsePath, path, panelId);
            });
        } else {
            writeResponse(responsePath, panelSuccess(requestId, @{
                @"action": @"accept", @"path": path, @"dismissed": @YES,
                @"interceptedBeforeDisplay": @YES,
            }));
            completePending(NSModalResponseOK);
        }
        return;
    }
    if (attempt >= 30) {
        writeResponse(responsePath, panelError(
            requestId, @"PATH_NOT_APPLIED",
            [NSString stringWithFormat:@"panel did not select exact path: %@ (actual: %@)",
                                       path, selected ?: @"none"]));
        if (gPendingPresentedForAutomation) [gPendingPanel cancel:nil];
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        acceptPendingWhenApplied(requestId, responsePath, path, panelId, attempt + 1);
    });
}

static void handleRequest(
    NSString *requestPath,
    NSString *responsePath,
    NSString *expectedRequestId
) {
    NSData *data = [NSData dataWithContentsOfFile:requestPath];
    NSDictionary *request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    [[NSFileManager defaultManager] removeItemAtPath:requestPath error:nil];

    NSString *requestId = [request isKindOfClass:[NSDictionary class]] &&
                          [request[@"id"] isKindOfClass:[NSString class]]
                              ? request[@"id"] : @"";
    if (![request isKindOfClass:[NSDictionary class]] ||
        ![request[@"protocol"] isEqual:@(kPanelProtocol)]) {
        writeResponse(responsePath, panelError(expectedRequestId, @"PROTOCOL_MISMATCH",
                                               @"unsupported native panel protocol"));
        return;
    }
    if (![requestId isEqualToString:expectedRequestId]) {
        writeResponse(responsePath, panelError(expectedRequestId, @"REQUEST_ID_MISMATCH",
                                               @"request id does not match its filename"));
        return;
    }
    NSNumber *created = request[@"createdAtMs"];
    NSTimeInterval nowMs = [[NSDate date] timeIntervalSince1970] * 1000.0;
    if (![created isKindOfClass:[NSNumber class]] ||
        nowMs - [created doubleValue] > kRequestMaxAgeMs ||
        [created doubleValue] > nowMs + 1000.0) {
        writeResponse(responsePath, panelError(requestId, @"STALE_REQUEST",
                                               @"native panel request is stale"));
        return;
    }

    NSString *action = request[@"action"];
    if ([action isEqualToString:@"status"]) {
        NSMutableDictionary *fields = [NSMutableDictionary dictionary];
        NSDictionary *state = currentPanelState();
        fields[@"panel"] = state ?: [NSNull null];
        NSPanel *unsupported = state ? nil : unsupportedNativePanel();
        if (unsupported) {
            fields[@"unsupportedNativeUI"] = @{
                @"class": NSStringFromClass([unsupported class]),
                @"title": [unsupported title] ?: @"",
            };
        }
        writeResponse(responsePath, panelSuccess(requestId, fields));
        return;
    }
    if (![action isEqualToString:@"accept"] && ![action isEqualToString:@"cancel"]) {
        writeResponse(responsePath, panelError(requestId, @"INVALID_ACTION",
                                               @"expected status, accept, or cancel"));
        return;
    }

    NSString *panelId = request[@"panelId"];
    if (gPendingPanel) {
        if (!pendingMatches(panelId)) {
            writeResponse(responsePath, panelError(requestId, @"PANEL_CHANGED",
                                                   @"pending panel changed after status was read"));
            return;
        }
        if ([action isEqualToString:@"accept"]) {
            NSString *path = request[@"path"];
            if (![path isKindOfClass:[NSString class]] || ![path isAbsolutePath]) {
                writeResponse(responsePath, panelError(requestId, @"INVALID_PATH",
                                                       @"accept path must be absolute"));
                return;
            }
            @try {
                NSDictionary *error = configurePendingPath(requestId, path);
                if (error) {
                    writeResponse(responsePath, error);
                    return;
                }
            } @catch (NSException *exception) {
                writeResponse(responsePath, panelError(
                    requestId, @"PATH_REJECTED",
                    [NSString stringWithFormat:@"panel rejected the path: %@", [exception reason]]));
                return;
            }
            if ([gPendingPanel isKindOfClass:[NSOpenPanel class]]) {
                if (!presentPendingForAutomation()) {
                    writeResponse(responsePath, panelError(
                        requestId, @"AUTOMATION_MARKER_FAILED",
                        @"could not cloak the Open panel before initialization"));
                    return;
                }
            }
            acceptPendingWhenApplied(requestId, responsePath, path, panelId, 0);
            return;
        }
        writeResponse(responsePath, panelSuccess(requestId, @{
            @"action": @"cancel", @"path": [NSNull null], @"dismissed": @YES,
            @"interceptedBeforeDisplay": @YES,
        }));
        if (gPendingPresentedForAutomation) {
            [gPendingPanel cancel:nil];
        } else {
            completePending(NSModalResponseCancel);
        }
        return;
    }

    NSSavePanel *panel = activeVisiblePanel();
    if (!panel) {
        NSPanel *unsupported = unsupportedNativePanel();
        writeResponse(responsePath, panelError(
            requestId,
            unsupported ? @"UNSUPPORTED_NATIVE_UI" : @"NO_PANEL",
            unsupported
                ? [NSString stringWithFormat:@"unsupported native panel: %@",
                                                   NSStringFromClass([unsupported class])]
                : @"no active Save/Open panel"));
        return;
    }
    if (!activeMatches(panel, panelId)) {
        writeResponse(responsePath, panelError(requestId, @"PANEL_CHANGED",
                                               @"active panel changed after status was read"));
        return;
    }
    if ([action isEqualToString:@"cancel"]) {
        [panel cancel:nil];
        writeResponse(responsePath, panelSuccess(requestId, @{
            @"action": @"cancel", @"path": [NSNull null], @"dismissed": @YES,
            @"interceptedBeforeDisplay": @NO,
        }));
        return;
    }
    writeResponse(responsePath, panelError(
        requestId, @"PANEL_NOT_INTERCEPTED",
        @"panel is already visible; cancel and trigger it again while the web-plane session is hidden"));
}

static void processPanelRequests(void) {
    if (!gRunDir || !gRunId) return;
    NSString *prefix = [NSString stringWithFormat:@".panel-request-%@-", gRunId];
    NSArray<NSString *> *names = [[NSFileManager defaultManager]
        contentsOfDirectoryAtPath:gRunDir error:nil];
    for (NSString *name in names) {
        if (![name hasPrefix:prefix] || ![name hasSuffix:@".json"]) continue;
        NSString *requestId = [name substringWithRange:NSMakeRange(
            [prefix length], [name length] - [prefix length] - [@".json" length])];
        NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:requestId];
        if (!uuid) continue;
        [uuid release];
        NSString *requestPath = [gRunDir stringByAppendingPathComponent:name];
        NSString *responseName = [NSString stringWithFormat:@".panel-response-%@-%@.json",
                                                             gRunId, requestId];
        handleRequest(requestPath,
                      [gRunDir stringByAppendingPathComponent:responseName],
                      requestId);
    }
}

static void handleSIGINFO(int signalNumber) {
    dispatch_async(dispatch_get_main_queue(), ^{
        processPanelRequests();
    });
}

static void installPresentationHooks(void) {
    Class panelClass = [NSSavePanel class];
    SEL beginSelector = @selector(beginWithCompletionHandler:);
    Method beginMethod = class_getInstanceMethod(panelClass, beginSelector);
    gOriginalBegin = method_getImplementation(beginMethod);
    method_setImplementation(beginMethod, imp_implementationWithBlock(
        ^(NSSavePanel *panel, void (^completion)(NSModalResponse)) {
            if (capturePending(panel, PendingModeless, nil, completion)) return;
            ((void(*)(id, SEL, void (^)(NSModalResponse)))gOriginalBegin)(
                panel, beginSelector, completion);
        }));

    SEL sheetSelector = @selector(beginSheetModalForWindow:completionHandler:);
    Method sheetMethod = class_getInstanceMethod(panelClass, sheetSelector);
    gOriginalBeginSheet = method_getImplementation(sheetMethod);
    method_setImplementation(sheetMethod, imp_implementationWithBlock(
        ^(NSSavePanel *panel, NSWindow *parent, void (^completion)(NSModalResponse)) {
            if (capturePending(panel, PendingSheet, parent, completion)) return;
            ((void(*)(id, SEL, NSWindow *, void (^)(NSModalResponse)))gOriginalBeginSheet)(
                panel, sheetSelector, parent, completion);
        }));
}

__attribute__((constructor))
static void initializePanelControl(void) {
    if (!isPanelBrowserProcess()) return;
    const char *runDir = getenv("WEB_PLANE_RUN_DIR");
    const char *runId = getenv("WEB_PLANE_RUN_ID");
    if (!runDir || !runId) return;
    gRunDir = [[NSString alloc] initWithUTF8String:runDir];
    gRunId = [[NSString alloc] initWithUTF8String:runId];
    gHiddenPath = [[gRunDir stringByAppendingPathComponent:
        [NSString stringWithFormat:@".chrome-hidden-%@", gRunId]] copy];
    gAutomationPath = [[gRunDir stringByAppendingPathComponent:
        [NSString stringWithFormat:@".panel-automation-%@", gRunId]] copy];
    signal(SIGINFO, handleSIGINFO);
    installPresentationHooks();
}
