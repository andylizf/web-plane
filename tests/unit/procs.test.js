import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';

// paths are derived from $HOME at import time, so the fake home has to be in
// place before lib/config.js is ever loaded.
const HOME = makeTmpDir('procs-home');
process.env.HOME = HOME;
process.on('exit', () => removeTmpDir(HOME));

const { paths } = await import('../../lib/config.js');
const { parseChromeLine, selectChrome } = await import('../../lib/procs.js');

const PROFILES = paths.profilesDir;
const CLONE = paths.chromeBin;

/** A `ps -axo pid=,command=` line, as the real one looks. */
function psLine(pid, bin, args = '') {
  return `  ${pid} ${bin}${args ? ' ' + args : ''}`;
}

const ours = (pid, session, port) =>
  psLine(pid, CLONE, `--user-data-dir=${join(PROFILES, session)} --remote-debugging-port=${port} --no-first-run`);

const theirs = (pid) => psLine(pid, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

test('a web-plane launch is recognised by its clone path and profile dir', () => {
  const p = parseChromeLine(ours(4242, 'work', 51234));
  assert.equal(p.pid, 4242);
  assert.equal(p.port, 51234);
  assert.equal(p.session, 'work');
  assert.equal(p.managed, true);
});

test("the user's own Chrome is never marked managed", () => {
  // managed=false is what stops a SIGUSR1 going to a Chrome with no handler for
  // it, where the default disposition is to terminate the process.
  const p = parseChromeLine(theirs(1114));
  assert.equal(p.session, null);
  assert.equal(p.managed, false);
  assert.equal(p.port, 0);
});

test('session names are not prefix-matched', () => {
  // `agtest` and `agtest2` are different browsers; a prefix match would let a
  // command aimed at one land on the other.
  assert.equal(parseChromeLine(ours(1, 'agtest2', 9222)).session, 'agtest2');
  const procs = [parseChromeLine(ours(1, 'agtest2', 9222))];
  assert.throws(() => selectChrome(procs, 'agtest'), /No Chrome process for session "agtest"/);
});

test('naming a session picks exactly that browser', () => {
  const procs = [ours(1, 'a', 1), ours(2, 'b', 2), theirs(3)].map(parseChromeLine);
  assert.equal(selectChrome(procs, 'b').pid, 2);
});

test('with no -s and several of our sessions up, it refuses instead of guessing', () => {
  const procs = [ours(1, 'a', 1), ours(2, 'b', 2)].map(parseChromeLine);
  assert.throws(() => selectChrome(procs, null), (e) => {
    assert.match(e.message, /2 web-plane sessions are running/);
    // The message has to name them: the failure it replaces was `show` reporting
    // success about a browser the caller had never heard of.
    assert.match(e.message, /a \(pid 1\)/);
    assert.match(e.message, /b \(pid 2\)/);
    return true;
  });
});

test('a read-only caller may pick one, and gets a real session', () => {
  const procs = [ours(1, 'a', 1), ours(2, 'b', 2)].map(parseChromeLine);
  assert.equal(selectChrome(procs, null, { unique: false }).session, 'a');
});

test("with no -s it picks our session, never the user's own Chrome", () => {
  const procs = [theirs(1114), ours(2, 'work', 5)].map(parseChromeLine);
  assert.equal(selectChrome(procs, null).pid, 2);
});

test('when only foreign Chromes are running it refuses to touch them', () => {
  const procs = [theirs(1114), theirs(1200)].map(parseChromeLine);
  assert.throws(() => selectChrome(procs, null), /will not touch a Chrome it did not start/);
});

test('no Chrome at all says so plainly', () => {
  assert.throws(() => selectChrome([], null), /No Chrome process found/);
  assert.throws(() => selectChrome([], 'work'), /No Chrome process found/);
});
