# fast — bare agent-browser

Fastest path, no stealth. Good for undefended sites, your own app, or quick scraping where
being flagged as automation doesn't matter. agent-browser's default engine is Chrome for
Testing, which reports `navigator.webdriver=true` and a HeadlessChrome UA — bot-walls
(Cloudflare/Turnstile/DataDome) will catch it, so don't use this on a protected or
logged-in site; use `stealth` for those.

## Install
```bash
npm install -g agent-browser && agent-browser install
```

## Drive
```bash
agent-browser open https://example.com
agent-browser snapshot            # refs e1,e2…
agent-browser click e3
agent-browser fill e5 "query"
agent-browser eval "document.title"
```

agent-browser runs a persistent daemon (~1ms warm commands) and has a broad surface
(network / cookies / storage / tab / diff). For a persistent login profile, launch Chrome
yourself with `--user-data-dir=<dir> --remote-debugging-port=<n>` and
`agent-browser connect <n>` — but if the login needs to survive *undetected*, that's exactly
what `stealth` is for; prefer it.
