/**
 * The lowest Node major this package claims to support.
 *
 * CI installs exactly this version and runs the tests on it, which is what turns
 * the `engines` field from a comment into a promise. It mattered here: the field
 * said >=18 while `show`, `hide` and `status` all open a CDP socket through the
 * global WebSocket, which does not exist before Node 22 — so on the version the
 * package advertised, every window command threw ReferenceError.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);
const range = pkg.engines?.node ?? '';
const major = range.match(/(\d+)/)?.[1];
if (!major) {
  console.error(`package.json engines.node ("${range}") does not name a version`);
  process.exit(1);
}
console.log(major);
