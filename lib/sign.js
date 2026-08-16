import { execSync, execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './config.js';

// DYLD_INSERT_LIBRARIES only loads an ad-hoc dylib into a binary that is itself
// ad-hoc signed. The cloned Chrome carries its own Keystone updater, and when it
// auto-updates it replaces the binary and re-signs it with Google's certificate
// (which restores the hardened runtime's library-validation flag). After that the
// window-suppression dylib silently fails to inject and windows flash on screen.
//
// This detects that state cheaply and heals it by re-applying the ad-hoc
// signature, so a background Chrome update can't quietly break stealth.
export function ensureInjectable() {
  const bin = paths.chromeBin;
  if (!existsSync(bin)) return false;
  let flags = '';
  try {
    flags = execSync(`codesign -dv "${bin}" 2>&1`, { encoding: 'utf8' });
  } catch {
    // No/broken signature — re-signing below fixes that too.
  }
  // 'adhoc' in the CodeDirectory flags means DYLD injection will work.
  if (/\bflags=\S*adhoc/.test(flags)) return false;
  try {
    execSync(`xattr -cr "${bin}" && codesign --force --sign - "${bin}"`, { stdio: 'ignore' });
    return true; // re-signed
  } catch (err) {
    // Swallowing this used to leave the caller believing the clone was fine.
    // It isn't: without an ad-hoc signature DYLD_INSERT_LIBRARIES is ignored, so
    // the window flashes on every launch and hide degrades to minimize.
    console.error(
      `\nweb-plane: WARNING — could not re-apply the ad-hoc signature to the cloned Chrome.\n` +
        `  DYLD injection will be ignored, so windows will appear on screen.\n` +
        `  ${err?.message?.split('\n')[0] ?? err}\n` +
        `  Fix: web-plane install   (needs Xcode Command Line Tools)\n`
    );
    return false;
  }
}

// macOS clones an app bundle into the per-user temporary area whenever it
// verifies that bundle's code signature, and Chromium asks for one of its own on
// every launch (the MacAppCodeSignClone feature). The clone is supposed to be
// dropped once the check is done; it isn't, so they accumulate — the same leak
// filed against other Chromium apps, e.g. capybara#2795 and codex#25667.
//
// Two reasons this hits web-plane harder than a normal Chrome install. The
// clone is re-signed ad-hoc on our side (see ensureInjectable), so Gatekeeper
// sees a bundle it has no cached assessment for and redoes the work; and the
// resting state here is a long-lived background browser that gets relaunched far
// more often than a human opens Chrome.
//
// Sizes are misleading: these are APFS copy-on-write clones sharing Chrome's
// blocks, so `du` bills each one for the whole bundle (~1.5 GB) when deleting it
// actually returns ~40 MB. Measured on one machine, 35 of them freed 1.39 GB.
// The growth is still unbounded — macOS only sweeps /var/folders on reboot or
// after ~30 days, which on a machine that is never rebooted means never.
const CHROME_CLONE_DIR = 'com.google.Chrome.code_sign_clone';
const HOUR_MS = 60 * 60 * 1000;

/**
 * Where macOS keeps this user's sign clones.
 *
 * Resolved at call time rather than hardcoded: the path embeds a per-user
 * opaque token, so a literal would be both wrong on every other machine and a
 * gratuitous disclosure in a public repo. `getconf` reports `…/T/` (the temp
 * dir); the clones sit beside it in `…/X/`.
 */
function chromeCloneDir() {
  try {
    const tempDir = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
    if (!tempDir) return null;
    return join(dirname(tempDir.replace(/\/+$/, '')), 'X', CHROME_CLONE_DIR);
  } catch {
    return null;
  }
}

/**
 * Which clones are safe to delete, given what's on disk.
 *
 * Split out from the deletion so the policy is testable without a filesystem.
 * Two guards, because a clone that is still in use must not be removed and
 * there is no cheap way to ask which one that is:
 *
 * - keep the `keepRecent` newest, since a running browser is holding one of them
 * - keep anything younger than `minAgeMs`, which covers a second session
 *   launching concurrently with this one
 *
 * Deleting an in-use clone is not fatal (macOS rebuilds it on the next check),
 * but it would make Gatekeeper redo work mid-session, so the guards stay.
 */
export function selectStaleClones(entries, { keepRecent = 2, minAgeMs = HOUR_MS, now = Date.now() } = {}) {
  return [...entries]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keepRecent)
    .filter((entry) => now - entry.mtimeMs >= minAgeMs)
    .map((entry) => entry.name);
}

/**
 * Delete leaked Chrome sign clones. Returns how many went.
 *
 * Best-effort by construction: this runs on the launch path, and a browser that
 * refused to start because a temp sweep failed would be a far worse bug than the
 * leak it is cleaning up. Every failure mode — no such directory, unreadable,
 * a clone held open — is swallowed and retried on the next launch.
 */
export function pruneCodeSignClones({ keepRecent = 2, minAgeMs = HOUR_MS } = {}) {
  const dir = chromeCloneDir();
  if (!dir || !existsSync(dir)) return 0;

  let entries;
  try {
    entries = readdirSync(dir)
      .filter((name) => name.startsWith('code_sign_clone.'))
      .map((name) => {
        try {
          return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
        } catch {
          return null; // vanished between readdir and stat
        }
      })
      .filter(Boolean);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of selectStaleClones(entries, { keepRecent, minAgeMs })) {
    const target = join(dir, name);
    // Belt and braces: whatever readdir handed back, only ever delete inside the
    // clone directory. A recursive delete is not something to aim by inference.
    if (!target.startsWith(`${dir}/`)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed++;
    } catch {
      // Still in use, or not ours to delete. Next launch tries again.
    }
  }
  return removed;
}
