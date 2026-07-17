# cloak — CloakBrowser kernel (not installed)

Reach for this only when `stealth`'s cloned real Chrome still gets walled — a hard Cloudflare
Turnstile / DataDome page that checks deeper signals (canvas, WebGL, ja3/ja4 TLS
fingerprints). CloakBrowser is a Chromium with dozens of source-level patches that strip
automation and fingerprint signals at the binary level (drop-in Playwright/Puppeteer API).

**Not installed.** Install on demand:
```bash
pip install cloakbrowser        # downloads a ~200MB signed stealth Chromium
```

Integration mirrors `stealth`: CloakBrowser is a *kernel*, so drive it with agent-browser
over CDP. Launch its Chromium with a `--remote-debugging-port` and
`agent-browser connect <port>`. Anti-detection lives in the binary, so it holds no matter
who drives. (Window suppression is a separate concern — that's web-plane's job, not
CloakBrowser's.)

Caveats:
- It avoids CAPTCHAs, it doesn't solve them — a challenge that fires still goes to the human.
- Verify macOS/arm64 install support before committing to it; it's a heavier dependency than
  `stealth`.
