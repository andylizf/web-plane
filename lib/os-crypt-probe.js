// Child process for os-crypt.js probeKeyTag(): launch <chromeBin> headless on
// <userDataDir> with the keychain switches the managed launch gets from
// Playwright, store one cookie over CDP, and close Chrome cleanly so the cookie
// is flushed to <userDataDir>/Default/Cookies. The caller reads the tag.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CdpConnection } from './cdp-client.js';

const [chromeBin, userDataDir] = process.argv.slice(2);
const portFile = join(userDataDir, 'DevToolsActivePort');

const chrome = spawn(chromeBin, [
  '--headless=new',
  // The two switches that select the key: Playwright passes both on every
  // managed launch (chromiumSwitches.js), and a non-default --user-data-dir.
  '--use-mock-keychain',
  '--password-store=basic',
  `--user-data-dir=${userDataDir}`,
  '--profile-directory=Default',
  '--disable-field-trial-config',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-component-update',
  '--disable-background-networking',
  '--remote-debugging-port=0',
  'about:blank',
], { stdio: 'ignore' });
const exited = new Promise((resolve) => chrome.once('exit', resolve));

const deadline = Date.now() + 30_000;
while (!existsSync(portFile)) {
  if (Date.now() > deadline || chrome.exitCode !== null) {
    chrome.kill('SIGKILL');
    console.error('Chrome did not open a DevTools port');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
const cdp = await CdpConnection.connect(port, 10_000);
await cdp.send('Storage.setCookies', {
  cookies: [{
    name: 'web_plane_os_crypt_probe',
    value: '1',
    domain: 'web-plane.invalid',
    path: '/',
    secure: true,
    expires: Math.floor(Date.now() / 1000) + 3600,
  }],
});
await cdp.send('Browser.close').catch(() => {});
const timer = setTimeout(() => chrome.kill('SIGKILL'), 15_000);
await exited;
clearTimeout(timer);
process.exit(0);
