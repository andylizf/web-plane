import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvocation, parseSessionFlag, parseLaneFlag } from '../../lib/args.js';

// Reading `-s` wrong is not a parse error, it is a command that acts on somebody
// else's browser. Every case below is a shape that has to resolve to the same
// session and the same command word.

test('finds the command after a global flag written with =', () => {
  const { command, globalArgs, commandArgs } = parseInvocation(['-s=deep', 'status']);
  assert.equal(command, 'status');
  assert.deepEqual(globalArgs, ['-s=deep']);
  assert.deepEqual(commandArgs, []);
});

test('a space-separated flag value is not mistaken for the command', () => {
  const { command, globalArgs } = parseInvocation(['-s', 'deep', 'status']);
  assert.equal(command, 'status');
  assert.deepEqual(globalArgs, ['-s', 'deep']);
});

test('command arguments survive intact', () => {
  const { command, commandArgs } = parseInvocation(['-s=work', 'attach', '--as', 'lane1', 'https://example.com']);
  assert.equal(command, 'attach');
  assert.deepEqual(commandArgs, ['--as', 'lane1', 'https://example.com']);
});

test('no command at all (bare --help) reports none', () => {
  const { command, commandIndex } = parseInvocation(['--help']);
  assert.equal(command, null);
  assert.equal(commandIndex, -1);
});

test('a switch does not swallow the command word', () => {
  // `--headed` takes no value, so `open` is the command. Before this was
  // special-cased, `open` was read as the flag's value and the url became the
  // command — proxied to playwright-cli as `https://example.com`.
  const { command, commandArgs } = parseInvocation(['--headed', 'open', 'https://example.com']);
  assert.equal(command, 'open');
  assert.deepEqual(commandArgs, ['https://example.com']);
});

test('an unknown flag is still assumed to take a value', () => {
  // playwright-cli owns most of these and keeps adding value-taking ones, so the
  // safe default is to consume the next word rather than treat it as a command.
  assert.equal(parseInvocation(['--timeout', '5000', 'open', 'https://x.com']).command, 'open');
});

test('--profile <path> is consumed as a value, not read as the command', () => {
  const { command, commandArgs } = parseInvocation(['--profile', '/some/dir', 'open', 'https://example.com']);
  assert.equal(command, 'open');
  assert.deepEqual(commandArgs, ['https://example.com']);
});

test('the session is found whether it comes before or after the command', () => {
  // `web-plane cdp -s=work` and `web-plane -s=work cdp` must name one browser.
  assert.equal(parseSessionFlag(['cdp', '-s=work']), 'work');
  assert.equal(parseSessionFlag(['-s=work', 'cdp']), 'work');
  assert.equal(parseSessionFlag(['cdp', '-s', 'work']), 'work');
  assert.equal(parseSessionFlag(['cdp']), null);
});

test('a dangling -s at the end is not read as a session name', () => {
  assert.equal(parseSessionFlag(['status', '-s']), null);
});

test('--as picks the lane and leaves the url', () => {
  assert.deepEqual(parseLaneFlag(['--as', 'work', 'https://example.com']), {
    lane: 'work',
    rest: ['https://example.com'],
  });
  assert.deepEqual(parseLaneFlag(['--as=work', 'https://example.com']), {
    lane: 'work',
    rest: ['https://example.com'],
  });
  assert.deepEqual(parseLaneFlag(['https://example.com']), {
    lane: null,
    rest: ['https://example.com'],
  });
});
