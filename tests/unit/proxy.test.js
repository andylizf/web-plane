import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmpdir.js';
import { runCli } from '../helpers/cli.js';

// A profile's proxy decides which country its traffic leaves from. The failures
// guarded here do not crash: they browse through the wrong exit, or print a
// password, while every command reports success.

const HOME = makeTmpDir('proxy-home');
process.env.HOME = HOME;
process.on('exit', () => removeTmpDir(HOME));

const { paths, CLI_CONFIG } = await import('../../lib/config.js');
const {
  maskProxy,
  parseProxy,
  proxyChromeArgs,
  proxyMismatch,
  readProfileProxy,
  requireProfileProxy,
  takeProxyFlags,
  writeProfileProxy,
} = await import('../../lib/proxy.js');
const { parseChromeLine } = await import('../../lib/procs.js');
const { launchConfigFor } = await import('../../lib/profile-runtime.js');
const { profileProxyCommand } = await import('../../lib/profiles.js');

const chromeLine = (session, extra = '') =>
  `4242 ${paths.chromeBin} --remote-debugging-port=9333 ${extra} ` +
  `--user-data-dir=${join(paths.profilesDir, session)}`;

test('socks5h is accepted and launched as Chrome socks5, which resolves names proxy-side', () => {
  assert.deepEqual(parseProxy('socks5h://127.0.0.1:1088'), { server: 'socks5://127.0.0.1:1088', bypass: null });
  assert.deepEqual(parseProxy('socks5://127.0.0.1:1088'), { server: 'socks5://127.0.0.1:1088', bypass: null });
  assert.deepEqual(parseProxy('http://[::1]:3128', '*.cn;10.0.0.0/8'), {
    server: 'http://[::1]:3128',
    bypass: '*.cn;10.0.0.0/8',
  });
});

test('a proxy with credentials is refused, and the refusal does not print them', () => {
  for (const url of ['socks5://alice:hunter2@127.0.0.1:1088', 'http://alice:hunter2@proxy.example:3128']) {
    assert.throws(() => parseProxy(url), (error) => {
      assert.match(error.message, /credentials/);
      assert.doesNotMatch(error.message, /hunter2|alice/);
      assert.match(error.message, /\*\*\*@/);
      return true;
    });
  }
  assert.equal(maskProxy('socks5://alice:hunter2@h:1'), 'socks5://***@h:1');
  assert.equal(maskProxy('socks5://h:1'), 'socks5://h:1');
});

test('only a bare scheme://host:port that Chrome understands is accepted', () => {
  assert.throws(() => parseProxy('ftp://h:21'), /not supported/);
  assert.throws(() => parseProxy('socks5://127.0.0.1'), /explicit host and port/);
  assert.throws(() => parseProxy('http://h:3128/path'), /nothing after it/);
  assert.throws(() => parseProxy('127.0.0.1:1088'), /not supported|not a URL/);
  assert.throws(() => parseProxy('socks5://h:1', 'a, b'), /no spaces/);
});

test('the switches Chrome receives name the proxy and nothing else', () => {
  assert.deepEqual(proxyChromeArgs(null), []);
  assert.deepEqual(proxyChromeArgs(parseProxy('socks5://127.0.0.1:1088')), ['--proxy-server=socks5://127.0.0.1:1088']);
  assert.deepEqual(proxyChromeArgs(parseProxy('http://h:1', '*.cn')), [
    '--proxy-server=http://h:1',
    '--proxy-bypass-list=*.cn',
  ]);
});

test("a running browser's exit is read back from its command line", () => {
  assert.equal(parseChromeLine(chromeLine('cn')).proxy, null);
  assert.deepEqual(
    parseChromeLine(chromeLine('cn', '--proxy-server=socks5://127.0.0.1:1088 --proxy-bypass-list=*.cn')).proxy,
    { server: 'socks5://127.0.0.1:1088', bypass: '*.cn' }
  );
});

test('a browser launched through another exit is refused, in both directions', () => {
  const socks = parseProxy('socks5://127.0.0.1:1088');
  const direct = parseChromeLine(chromeLine('cn'));
  const proxied = parseChromeLine(chromeLine('cn', '--proxy-server=socks5://127.0.0.1:1088'));
  const other = parseChromeLine(chromeLine('cn', '--proxy-server=socks5://127.0.0.1:2000'));
  assert.equal(proxyMismatch('cn', null, socks), null, 'nothing running is nothing to refuse');
  assert.equal(proxyMismatch('cn', proxied, socks), null);
  assert.equal(proxyMismatch('cn', direct, null), null);
  assert.match(proxyMismatch('cn', direct, socks), /launched with direct[\s\S]*web-plane -s=cn close/);
  assert.match(proxyMismatch('cn', other, socks), /127\.0\.0\.1:2000/);
  assert.match(proxyMismatch('cn', proxied, null), /should exit through direct/);
});

test('the stored exit survives a round trip and clear removes it', () => {
  writeProfileProxy('rt', parseProxy('socks5h://127.0.0.1:1088', '*.cn'));
  assert.deepEqual(readProfileProxy('rt'), { server: 'socks5://127.0.0.1:1088', bypass: '*.cn' });
  writeProfileProxy('rt', null);
  assert.equal(readProfileProxy('rt'), null);
  writeProfileProxy('rt', null); // clearing twice is not an error
});

test('--proxy stores the exit only while no browser is running', () => {
  const socks = parseProxy('socks5://127.0.0.1:1088');
  const running = parseChromeLine(chromeLine('req'));
  assert.throws(() => requireProfileProxy('req', socks, running), /cannot switch[\s\S]*-s=req close/);
  assert.equal(readProfileProxy('req'), null, 'a refused request must not be stored');
  assert.deepEqual(requireProfileProxy('req', socks, null), { changed: true, proxy: socks, previous: null });
  assert.equal(requireProfileProxy('req', socks, null).changed, false);
  const proxied = parseChromeLine(chromeLine('req', '--proxy-server=socks5://127.0.0.1:1088'));
  assert.equal(requireProfileProxy('req', socks, proxied).changed, false, 'the same exit is not a switch');
  writeProfileProxy('req', null);
});

test('--proxy and --proxy-bypass are taken out of the command arguments', () => {
  assert.deepEqual(takeProxyFlags(['--as', 'x', 'https://a.example']), {
    proxy: undefined,
    rest: ['--as', 'x', 'https://a.example'],
  });
  assert.deepEqual(takeProxyFlags(['https://a.example', '--proxy', 'socks5h://127.0.0.1:1088', '--proxy-bypass=*.cn']), {
    proxy: { server: 'socks5://127.0.0.1:1088', bypass: '*.cn' },
    rest: ['https://a.example'],
  });
  assert.throws(() => takeProxyFlags(['--proxy']), /requires a value/);
  assert.throws(() => takeProxyFlags(['--proxy-bypass', '*.cn']), /needs --proxy/);
  assert.throws(() => takeProxyFlags(['--proxy', 'socks5://h:1', '--proxy=socks5://h:2']), /only once/);
});

test('a proxied profile launches from its own config; the shared one is left alone', () => {
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(CLI_CONFIG));
  assert.equal(launchConfigFor('plain'), paths.config, 'a direct profile launches exactly as before');

  writeProfileProxy('cn', parseProxy('socks5://127.0.0.1:1088', '*.example'));
  const path = launchConfigFor('cn');
  assert.notEqual(path, paths.config);
  const args = JSON.parse(readFileSync(path, 'utf8')).browser.launchOptions.args;
  assert.ok(args.includes('--proxy-server=socks5://127.0.0.1:1088'), args.join(' '));
  assert.ok(args.includes('--proxy-bypass-list=*.example'), args.join(' '));
  assert.ok(args.includes('--profile-directory=Default'), 'the managed launch flags are kept');
  assert.equal(
    JSON.parse(readFileSync(paths.config, 'utf8')).browser.launchOptions.args.some((a) => a.startsWith('--proxy')),
    false,
    'the shared config, used by every other profile, gained a proxy'
  );

  writeProfileProxy('cn', parseProxy('socks5://127.0.0.1:2000'));
  const replaced = JSON.parse(readFileSync(launchConfigFor('cn'), 'utf8')).browser.launchOptions.args;
  assert.deepEqual(replaced.filter((a) => a.startsWith('--proxy')), ['--proxy-server=socks5://127.0.0.1:2000']);
  writeProfileProxy('cn', null);
});

test('proxy set and clear need an explicit profile and a stopped browser', () => {
  const quiet = { log: console.log, error: console.error };
  const lines = [];
  console.log = console.error = (line) => lines.push(String(line));
  try {
    assert.equal(profileProxyCommand('default', null, ['set', 'socks5://127.0.0.1:1088'], null), 2);
    assert.equal(existsSync(join(paths.profileProxiesDir, 'default.json')), false);

    const running = parseChromeLine(chromeLine('cmd'));
    assert.equal(profileProxyCommand('cmd', 'cmd', ['set', 'socks5://127.0.0.1:1088'], running), 1);
    assert.equal(readProfileProxy('cmd'), null);

    assert.equal(profileProxyCommand('cmd', 'cmd', ['set', 'socks5h://127.0.0.1:1088', '--bypass', '*.cn'], null), 0);
    assert.deepEqual(readProfileProxy('cmd'), { server: 'socks5://127.0.0.1:1088', bypass: '*.cn' });
    assert.equal(profileProxyCommand('cmd', 'cmd', ['set', 'socks5://bob:pw123@127.0.0.1:1088'], null), 2);
    assert.deepEqual(readProfileProxy('cmd'), { server: 'socks5://127.0.0.1:1088', bypass: '*.cn' });

    lines.length = 0;
    assert.equal(profileProxyCommand('cmd', 'cmd', [], running), 0);
    assert.match(lines.join('\n'), /Exit:\s+socks5:\/\/127\.0\.0\.1:1088 \(bypass \*\.cn\)/);
    assert.match(lines.join('\n'), /launched with direct/);

    assert.equal(profileProxyCommand('cmd', 'cmd', ['clear'], null), 0);
    assert.equal(readProfileProxy('cmd'), null);
  } finally {
    Object.assign(console, quiet);
  }
  assert.equal(lines.some((line) => line.includes('pw123')), false, 'a password reached the output');
});

test('the CLI refuses a credentialed --proxy before anything launches, without echoing it', () => {
  const home = makeTmpDir('proxy-cli-home');
  try {
    const attach = runCli(['-s=cn', 'attach', '--as', 'x', 'https://a.example', '--proxy', 'socks5://bob:pw123@127.0.0.1:1088'], { home });
    assert.equal(attach.code, 2, attach.all);
    assert.match(attach.stderr, /credentials/);
    assert.doesNotMatch(attach.all, /pw123|bob/);

    const set = runCli(['-s=cn', 'proxy', 'set', 'socks5h://127.0.0.1:1088'], { home });
    assert.equal(set.code, 0, set.all);
    const shown = runCli(['-s=cn', 'proxy'], { home });
    assert.match(shown.stdout, /Exit:\s+socks5:\/\/127\.0\.0\.1:1088/);
    assert.match(shown.stdout, /Running: no/);

    mkdirSync(join(home, '.web-plane', 'profiles', 'cn'), { recursive: true });
    const listing = runCli(['profiles'], { home });
    assert.equal(listing.code, 0, listing.all);
    assert.match(listing.stdout, /EXIT/);
    assert.match(listing.stdout, /cn\s+idle.*socks5:\/\/127\.0\.0\.1:1088/);
  } finally {
    removeTmpDir(home);
  }
});
