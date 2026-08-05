// focusmon — an independent, event-level record of every frontmost-application
// change on this machine, as JSONL on stdout.
//
// Why this exists: "did the hidden browser steal focus?" was being answered by
// sampling `frontmost app` before and after a launch. That question cannot be
// answered by sampling. A launch that grabs focus and hands it back within one
// frame is invisible to any poll slower than the grab, and it is exactly the
// grab a user feels — the menu bar flickers, a keystroke lands in the wrong
// window — so the check most likely to miss it is the one aimed at it.
//
// NSWorkspace posts a notification on every activation, synchronously with the
// switch itself. Nothing is missed regardless of how briefly the app held the
// front, and each event carries its own timestamp rather than the time some
// poller got around to noticing.
//
// The monitor must never become frontmost itself, or it corrupts the very
// signal it records: a process that shows up in its own log is indistinguishable
// from the culprit. NSApplicationActivationPolicyProhibited makes that
// structural rather than careful — the app is not eligible for activation at
// all. That is also, not coincidentally, the fix this tool was written to
// verify: window-level cloaking cannot stop an app from being activated,
// because activation is granted to the *application*, not to its windows.
//
// Usage:   focusmon [seconds]        (0 or omitted = run until SIGINT/SIGTERM)
// Compile: cc -Wall -Werror -framework AppKit -framework Foundation \
//              -o focusmon focusmon.m
//
// Output (one JSON object per line, flushed immediately so a tail -f is live):
//   {"t":"2026-08-05T18:45:12.345+0800","ms":1754...,"event":"baseline",...}
//   {"t":...,"event":"activate","app":"Google Chrome","bundle":"com.google.Chrome","pid":123}
//   {"t":...,"event":"deactivate",...}

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

static NSDateFormatter *gFmt;

static void emit(NSString *event, NSRunningApplication *app) {
    NSDate *now = [NSDate date];
    // Milliseconds since epoch as well as the readable stamp: the readable one
    // is for a human scanning the log, the numeric one is for diffing two
    // events without parsing a timezone.
    long long ms = (long long)([now timeIntervalSince1970] * 1000.0);

    NSString *name = app.localizedName ?: @"(unknown)";
    NSString *bundle = app.bundleIdentifier ?: @"(none)";
    // Chrome's own binary path distinguishes the web-plane clone from the
    // system install, and that distinction is the difference between "stealth
    // degraded to system Chrome" and "the clone itself grabbed focus".
    NSString *path = app.bundleURL.path ?: @"(none)";

    // Which policy the app is actually running under, read from the process
    // itself. Without this the log can only show that no event arrived, and
    // "no event" is ambiguous between "nothing happened" and "the observer
    // cannot see this class of app".
    const char *policy = "?";
    switch (app.activationPolicy) {
        case NSApplicationActivationPolicyRegular:    policy = "Regular";    break;
        case NSApplicationActivationPolicyAccessory:  policy = "Accessory";  break;
        case NSApplicationActivationPolicyProhibited: policy = "Prohibited"; break;
    }

    printf("{\"t\":\"%s\",\"ms\":%lld,\"event\":\"%s\","
           "\"app\":%s,\"bundle\":%s,\"pid\":%d,\"policy\":\"%s\",\"path\":%s}\n",
           [[gFmt stringFromDate:now] UTF8String],
           ms,
           [event UTF8String],
           [[NSString stringWithFormat:@"\"%@\"", name] UTF8String],
           [[NSString stringWithFormat:@"\"%@\"", bundle] UTF8String],
           (int)app.processIdentifier,
           policy,
           [[NSString stringWithFormat:@"\"%@\"", path] UTF8String]);
    fflush(stdout);
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        double seconds = (argc > 1) ? atof(argv[1]) : 0.0;

        gFmt = [[NSDateFormatter alloc] init];
        gFmt.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ";

        // Instantiate NSApp before setting the policy: the policy is a property
        // of the application object, and asking for it is what creates one.
        [NSApplication sharedApplication];
        // Check the effect, not the return code. A bundle-less binary already
        // starts Prohibited, and setting a policy to the value it already holds
        // answers NO — so trusting the return here rejects the exact state we
        // were asking for. What matters is where the policy ended up.
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        if ([NSApp activationPolicy] != NSApplicationActivationPolicyProhibited) {
            fprintf(stderr, "focusmon: activation policy is %ld, not Prohibited; "
                            "readings would include this process\n",
                    (long)[NSApp activationPolicy]);
            return 1;
        }

        NSNotificationCenter *nc = [[NSWorkspace sharedWorkspace] notificationCenter];

        [nc addObserverForName:NSWorkspaceDidActivateApplicationNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification *n) {
            emit(@"activate", n.userInfo[NSWorkspaceApplicationKey]);
        }];

        [nc addObserverForName:NSWorkspaceDidDeactivateApplicationNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification *n) {
            emit(@"deactivate", n.userInfo[NSWorkspaceApplicationKey]);
        }];

        // Baseline first: without knowing who held the front when recording
        // started, a log containing one activate event cannot say whether focus
        // was taken from someone or simply returned to where it already was.
        NSRunningApplication *front = [[NSWorkspace sharedWorkspace] frontmostApplication];
        if (front) emit(@"baseline", front);

        // A second, independent signal, because the notification above has a
        // blind spot that this tool was fooled by once already: it is posted for
        // ordinary foreground apps, and an app running under
        // NSApplicationActivationPolicyAccessory can hold the keyboard without
        // ever generating one. Reading frontmostApplication directly asks the
        // workspace who is in front rather than waiting to be told, so an
        // Accessory app that took focus still shows up here. If the two sources
        // ever disagree, the poll is the one to believe — a silent steal is
        // exactly the failure the notification cannot report.
        //
        // activationPolicy is logged with it: that turns "did the fix apply?"
        // into an observation instead of an inference from the absence of
        // events, which is how the first fix appeared to work.
        __block pid_t lastPid = front ? front.processIdentifier : 0;
        NSTimer *poll = [NSTimer timerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *t) {
            NSRunningApplication *now = [[NSWorkspace sharedWorkspace] frontmostApplication];
            if (!now || now.processIdentifier == lastPid) return;
            lastPid = now.processIdentifier;
            emit(@"poll-front", now);
        }];
        [[NSRunLoop currentRunLoop] addTimer:poll forMode:NSRunLoopCommonModes];

        if (seconds > 0) {
            [[NSRunLoop currentRunLoop] runUntilDate:
                [NSDate dateWithTimeIntervalSinceNow:seconds]];
        } else {
            [[NSRunLoop currentRunLoop] run];
        }
    }
    return 0;
}
