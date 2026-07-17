import { execSync } from 'child_process';
import { existsSync } from 'fs';
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
  } catch {
    return false;
  }
}
