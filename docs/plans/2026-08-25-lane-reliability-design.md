# Lane reliability design

## Scope and decisions

Issues #17–#29 describe one reliability gap: web-plane exposes a persistent,
tab-bound browser, but its lane boundary does not yet make the safe operation,
recovery, and diagnosis paths obvious. Several requested primitives already
exist in pinned agent-browser 0.34.0 (`fill`, semantic `find`,
`scrollintoview`, `wait`, `console`, and `network requests`). Forking or
duplicating those operations would create two subtly different drivers.
web-plane will instead publish a concise lane help surface, add safe aliases and
defaults where a mistaken operation is destructive, and implement only behavior
that requires ownership of the web-plane profile, Chrome process, or pinned tab.

The compatibility rule is that explicit agent-browser commands keep their
meaning except for `lane type`: replacement becomes the safe default and
append semantics require `--append`. `lane close` becomes tab-scoped and removes
the lane mapping; session-wide shutdown remains `web-plane -s=<profile> close`.
Navigation waits for network idle by default, with explicit wait condition,
timeout, and no-wait overrides. A covered click first centers the target and
retries once. Ref-independent interaction is documented through agent-browser's
semantic `find` command rather than a second selector grammar.

## Owned runtime behavior and diagnostics

Before launching a managed profile, web-plane normalizes Chrome's clean-exit
preferences and disables address/password-save prompts. Launch includes
Chrome's crashed-session-bubble suppression and a per-session Chrome log. The
previous log is retained before a new launch. Browser-death errors point to the
log and to an append-only session event file, so disappearance is no longer a
diagnosis-free state.

Each attached lane starts a small detached CDP observer bound to the pinned
target. It records timestamped console messages, page exceptions, failed
requests (including CDP `errorText`), target loss, and browser disconnects to a
mode-0600 JSONL file. It attaches to out-of-process frames, so diagnostics cover
the same frame tree that snapshot exposes. `lane netlog --failed` reads this
buffer, and page errors or failed requests that appear during a successful input
command produce a warning instead of an unqualified success. The monitor is
replaced on re-attach and stopped on lane close; logs remain as crash evidence.

`eval --all-frames` uses the same CDP frame discovery and returns one structured
result per accessible execution context, including frame URL and per-frame
errors. Keyboard commands report the focused document/element before dispatch;
`clear <selector>` provides the common iframe-safe replacement primitive. A
plain snapshot checks viewport canvas coverage and adds a screenshot hint when
a large canvas can hide application state from the accessibility tree.

## Verification and rollout

Unit tests cover argument translation, help/unknown-command behavior, preference
normalization, identity extraction, event-log filtering, canvas detection,
all-frame result formatting, tab-close cleanup, and navigation wait policy.
Real-Chrome integration tests exercise a prefilled input, sticky-header retry,
same- and cross-origin frames, focused iframe keys, canvas hints, tab-scoped
close with a surviving sibling lane, failed network requests, and browser-log
creation. Every issue gets a named assertion so partial implementation cannot
close the batch accidentally.

The full run uses an isolated project-local runtime on mac-mini. A resumable
runner writes one JSONL record per test file with start/end timestamps, duration,
commit, exact command, stdout/stderr paths, and pass/fail state. One smoke case
from each behavior group runs before the full suite. The package version and
runtime protocol are bumped only if installation must deploy a changed launch
configuration; `doctor` must reject the previous protocol in that case.
