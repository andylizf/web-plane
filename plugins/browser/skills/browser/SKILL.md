---
name: browser
description: >-
  Drive a web browser to accomplish a task — logging into a site, filling forms, scraping
  content behind auth, clicking through a flow, or operating a page a plain fetch can't reach.
  Use whenever a task needs a real browser: a logged-in session, a site that blocks bots
  (Cloudflare/Turnstile/DataDome), form submission, multi-step navigation, or "go to this site
  and do X" — even if the user never says the word "browser". It picks the right driving
  method and handles the shared concerns (which login profile, attaching over CDP, handing
  CAPTCHAs back to the human). It does not wrap another AI to drive for you — you are the
  driver.
---

# Driving a browser

## The one principle that shapes everything

**You are the agent loop.** Frameworks like browser-use or Stagehand exist to give a
*non-AI program* the ability to look at a page, decide the next action, and execute it. But
you already do that — you read a snapshot, decide, call a tool, read the result, adjust.
Wrapping one of those frameworks would mean calling an agent that calls *another* (usually
weaker) model to do what you can already do directly: double the latency and cost, plus a
hidden inner loop you can't see or debug.

So this skill never outsources the *driving intelligence*. It only helps you pick the right
**hands** (the operation layer) and the right **kernel** (the browser that does or doesn't
get detected), and it handles the concerns every method shares. The driving is always you.

## Step 0 — do you even need a browser?

If the task is just "read what's on this page" or "find X on the web", use `WebFetch` /
`WebSearch`. No browser, no login, no flakiness — fastest and safest, and most "go look at
this page" tasks are actually this. Open a browser only when you need to *act* (log in,
click, fill, submit) or reach content a fetch can't (a JS-heavy SPA behind auth).

## Step 1 — pick the kernel (which Chrome, how detectable)

Every real method below drives Chrome over **CDP**; they differ in *which* Chrome and how
detectable it is. Default to the lightest one that clears the site's defenses.

| Situation | Method | Why |
|---|---|---|
| Undefended site, or your own app, just want speed | **fast** → `references/fast.md` | Bare agent-browser. Fastest. `webdriver=true`, so bot-walls catch it. |
| Needs a logged-in session, or the site blocks bots (macOS) | **stealth** → `references/stealth.md` | web-plane's cloned real Chrome (`webdriver=false`) + agent-browser. Invisible, doesn't steal focus. **Default for anything real.** |
| Real Chrome still gets walled (hard Cloudflare/DataDome) | **cloak** → `references/cloak.md` | CloakBrowser's source-level anti-detect kernel. Not installed — install on demand. |
| No DOM: native app, canvas, or deliberately obfuscated page | **computer-use** → `references/computer-use.md` | Pixel-level. Slow but universal. |

## Step 2 — where does it run?

Local by default. Reach for the cloud only when you need scale a laptop can't give:

| Situation | Method |
|---|---|
| One or a few sessions, interactive | Local (any Step 1 method) |
| Hundreds of concurrent browsers + residential IPs for large scraping | **cloud** → `references/cloud.md` (Browserbase; not installed) |

## The common layer (applies to every CDP method)

These concerns are shared, so handle them the same way regardless of method — the
per-method references only cover what's unique to them.

### Login profile — pick the right identity
Every CDP method runs Chrome against a `--user-data-dir` profile (web-plane exposes it as
`-s=<name>`). A profile *is* a login identity: its cookies, tokens, and fingerprint.
- **One stable identity = one profile.** Reuse it so you don't re-login every time.
- **Don't mix unrelated accounts in one profile** — it tangles login state and lets a site
  correlate them as the same person. When unsure, separate.
- **Don't spin up a fresh profile per throwaway task** — each is a full Chrome profile (tens
  of MB) and its login expires. Use one shared scratch profile for login-less one-offs.
- Name profiles by identity, not task: `-s=cscse`, `-s=qqdocs`, not `-s=print-thing`.

### Attaching — the connect pattern
The kernel and the hands are separate processes joined by a CDP port. Always: start/reuse
the kernel, get its port, attach agent-browser.
```
web-plane -s=<name> cdp        # prints: Attach: agent-browser connect <port>
agent-browser connect <port>
```
The port is auto-assigned — read it from the command's output, never hardcode it.

### Selecting the tab
Attaching to a session that already has tabs lands you on *some* existing target, not
necessarily the one you want. Check and pick:
```
agent-browser tab list
agent-browser tab <n>
```

### CAPTCHAs, sliders, MFA — hand them to the human
These are exactly what the site put there to stop automation. Do not try to solve or bypass
them. Stop, say what's on screen, and let the user do that step. Stealth avoids being
*flagged*; it does not defeat a challenge that fires.

### Visibility choreography — show only the finished step
The hidden window is the default state for the entire task. `show` exists for exactly one
moment: when the human must act (login, CAPTCHA, MFA, a final confirm). The contract:

1. **Stage everything while hidden.** Navigate, click through menus, fill what you can,
   and verify (by snapshot) that the page on screen is *the* screen the human must touch —
   the login form itself, not the homepage that links to it.
2. **Then show, and say precisely what to do.** The user's first glance should land on
   their step, ready to go. Making the user watch you click around, or dumping them on an
   intermediate page, wastes the whole point of an invisible browser.
3. **After their step is done, take back over** — verify the result by snapshot and `hide`
   again before continuing.

If you discover mid-staging that you can't reach the handoff screen (e.g. a wall fires
early), that changes what you show — re-stage so the wall itself is the screen, then show.

### Readiness
Before driving, make sure the method's tools are installed and the kernel is up. Each
reference lists its install line; if a command is missing, install it rather than failing.

## Where to go next

Pick the method from Step 1/2 and open its reference for exact install + drive steps.
`stealth` is the right default for almost anything involving a real, logged-in, or
bot-protected site.
