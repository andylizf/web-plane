# Chrome-native session restore design

## Context

web-plane currently treats a dead Chrome process as the end of every lane. It
remembers only the lane's profile and CDP port, clears Chrome's saved session
after a failed launch, and asks the caller to attach again with a URL. That
throws away state Chrome already knows how to persist: windows, tabs, and
navigation entries. Volatile renderer state is recovered only when Chrome had
already written it to the session file before the process loss.

Chrome-native restore should own browser-page recovery. web-plane should own
the information Chrome does not know: which named lane belonged to which tab,
whether a restored target is an unambiguous match, and when a restore attempt
must be quarantined to avoid a crash loop.

## Requirements

- A managed profile uses Chrome's "continue where you left off" behavior.
- The first launch after a browser death attempts native session restore.
- Saved Chrome session data is backed up before the attempt and is never
  deleted without a confirmed backup.
- A recovered lane binds to the restored tab without replaying its previous
  command.
- A lane is rebound only when the restored target match is unambiguous.
- If the restored browser dies before becoming usable, web-plane preserves the
  failed evidence, quarantines the live restore data, and launches clean once.
- Full URLs remain local, mode 0600, and are not printed in ordinary logs or
  errors. Query strings and fragments may contain credentials.
- Real-Chrome verification runs only on mac-mini in an isolated profile.

## Non-goals

- Replaying clicks, submissions, uploads, or JavaScript after a crash.
- Claiming that Chrome restores every DOM or application-memory value.
- Guessing among several restored tabs with the same recovery identity.
- Restoring a Chrome inner profile when multiple live browser contexts make the
  identity ambiguous.

## State ownership

Chrome remains the source of truth for the browsing session. web-plane stores a
small lane index:

```json
{
  "version": 1,
  "lane": "application",
  "session": "main",
  "port": 61395,
  "targetId": "OLD_TARGET_ID",
  "url": "https://portal.example/form?step=3#address",
  "title": "Application",
  "tabIndex": 2,
  "updatedAt": "2026-08-25T21:30:00.000Z"
}
```

The current file is an atomic pointer. Each navigation update also remains in
the lane's append-only event log, so a later update does not erase the recovery
history. The lane directory is mode 0700 and files are mode 0600.

The detached lane monitor updates the record after top-frame committed and
same-document navigations, and after target-info changes that provide a title.
The URL is never inferred from a command that may not have completed.

## Native restore lifecycle

Before launching an idle profile, web-plane enables Chrome's last-session
startup preference and normalizes the exit marker as it already does for
unattended launch. If Chrome has session files, web-plane copies them into a
timestamped project-owned backup directory before the first launch attempt.

The first launch preserves Chrome's session files and lets Chrome restore them.
web-plane waits for the CDP endpoint, then enumerates the restored page targets.
A stable endpoint means recovery may proceed. A browser that publishes a port
and dies is a failed restore attempt; web-plane records the failure, confirms
the backup, quarantines the active session files, and makes one clean launch.
It does not keep retrying the poisoned restore.

Chrome 151.0.7922.138 on mac-mini restored both crashed tabs with
`--restore-last-session`, with or without `--disable-session-crashed-bubble` and
with or without an explicit startup URL. The last-session preference alone did
not bypass Chrome's crash-safety path. A hard crash did not reliably retain the
fixture's most recent input or scroll position, so recovery does not promise
volatile page state.

## Lane rebinding

Chrome assigns new CDP target IDs after restore, so the old target ID is only
evidence, not a reusable handle. Rebinding compares the stored lane record with
the restored target list:

1. Prefer one exact URL and title match.
2. If title is unavailable, accept one exact URL match.
3. Treat two targets with the same URL and title as ambiguous; CDP target-list
   order is not a documented tab identity and must not be used to guess.
4. If zero or multiple candidates remain, report the sanitized candidate list
   and require a new explicit attach.

On a unique match, web-plane reconnects the lane's agent-browser daemon,
selects the restored CDP target, restores strict pinning, starts a new monitor,
and writes the new port and target ID. The command that encountered the death
does not continue. The next command begins against a fresh snapshot/ref set.

## User-facing behavior

A lane command that discovers a dead browser starts the profile and attempts
native recovery once. A successful rebind exits with a distinct recovery
diagnostic rather than silently executing the original command:

```text
web-plane: restored lane 'application' with Chrome's saved session.
  The previous command was not replayed; run it again after a fresh snapshot.
```

An ambiguous restore reports why no choice was made. A poisoned restore reports
the backup path and that Chrome was relaunched cleanly. No message prints the
full saved URL.

## Verification

Unit tests cover preference merging, backup-before-quarantine, permissions,
legacy lane-state migration, navigation updates, unique/ambiguous matching,
and the recovery state machine.

The mac-mini integration creates an isolated runtime, profile, and lane, loads
a local fixture, and kills Chrome. After relaunch it proves that Chrome restored
the tab, the lane rebound to the new target and port, the interrupted command
was not replayed, and a verified pre-launch session backup exists. Unit tests
cover one backed-up quarantine and clean fallback without a deletion-first path.
