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

### Profile and lane — the identity, and your seat inside it
Two separate axes, and confusing them is the single most common way this goes wrong.

**Profile (`-s=<name>`)** is the *login identity* — a `--user-data-dir` holding cookies,
tokens, and fingerprint. Chrome runs exactly one process per profile, so everyone on a
profile shares one browser.
- **Default to the user's one main profile.** A second profile holding the same account is
  a second device to that site: it re-triggers new-device checks and splits your logins
  across places you then have to log into again.
- Reach for a separate profile only for a genuinely separate identity — a different
  account on the same site, or work you want uncorrelated.
- Name by identity, never by task: `-s=main`, `-s=work-alt`; not `-s=print-thing`.
- Never spin up a throwaway profile per task. It starts logged out and never gets cleaned up.

**Which profile is it?** Ask the disk, don't infer from the name:
```
web-plane profiles            # each profile: running/idle, size, sites it holds a session for
web-plane profiles x.com      # → the profile already logged into x.com, if any
```
Two ways this goes wrong even when you know the rule above. First, `web-plane list` is *not*
a web-plane command — it proxies to playwright-cli and prints that tool's session registry,
which omits profiles it never opened and keeps names whose dirs are long gone. It reads as
authoritative and costs a login you didn't need. Second, if your check for an existing
profile is shaped like `grep <the-name-I-was-about-to-create>`, you are confirming a decision
rather than discovering one; by construction it cannot find the profile you should reuse.

**Lane (`--as <name>`)** is *your seat* in that shared browser: one agent-browser daemon
plus one labelled tab. Concurrent agents = same `-s`, different `--as`.

### Attaching — one command
```
web-plane -s=main attach --as <lane> <url>
```
Starts or reuses the hidden browser for that profile, opens `<url>` in a tab labelled
`<lane>`, and connects an isolated agent-browser session. Prefer this over doing
`cdp` + `connect` by hand — the manual path has three ways to slip: forgetting
`--session` (every agent then shares one daemon, and a second `connect` against a daemon
that already holds a browser is a *silent no-op*, so you drive someone else's browser while
believing it's yours), landing on a stray tab, and hardcoding a port that changes each launch.

### Driving — always through the lane
```
web-plane lane <lane> snapshot
web-plane lane <lane> click e3
web-plane lane <lane> get url
```
`web-plane lane` checks whether your tab is still the active one, re-pins only if it isn't,
and then runs the agent-browser command against it. The check is load-bearing: a re-pin
clears the snapshot ref table, so `snapshot` followed by `click e3` only works when nothing
moved the pointer in between. If something did, the refs are gone — take a fresh snapshot
instead of reusing them.

**Do not call `agent-browser` directly on a shared browser.** agent-browser tracks one
active tab per session, and *any* session opening a tab drags every other session's pointer
onto it — and leaves it there. Two agents silently converge onto one tab the first time
either follows a link into a new one, and from then on they overwrite each other. The
re-pin is what prevents that; `lane` just makes it unforgettable.

A lane owns exactly one tab. If you need a second page, take a second lane.

### Checking the setup is real
```
web-plane doctor
```
Stealth is layered (patched playwright → cloned Chrome → DYLD hook → hidden window) and a
broken layer degrades quietly rather than failing: you get the *system* Chrome, a visible
window, and a `hide` that can only minimize. If windows are showing up, run this first —
it names the broken layer and the fix.

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

**`show` reported success but the screen is wrong.** Check the session first: with several
browsers up an unqualified `show` refuses rather than guessing, so the question is whether
the `-s=` you passed is the session you were actually driving. Past that, suspect an
OS-level block. macOS Screen Time paints its notice *over* the Chrome window — it is not
page content, so a page screenshot renders what's underneath and looks perfectly normal,
and while the window sits hidden at alpha 0 the notice is invisible along with everything
else. The block cannot be seen from inside the browser at all; `screencapture -x` of the
display is the only view that shows it.

### Who drives — a subagent, not this conversation
Snapshots are the cost. An accessibility tree runs to hundreds of lines, a real task needs
many of them, and whoever issues the commands carries every one of them for the rest of the
session. Run browser work in a subagent so that transcript is disposable.

This is not the AI-wrapping ruled out at the top of this file: a subagent is the same loop
and the same model, reading the same snapshots and making the same decisions. The only thing
that changes is whose context absorbs them.

Give it the goal, the profile, and the lane; ask back for conclusions — the answer you went
for, what changed, the final URL. Never raw snapshots, never `.playwright-cli/` dumps.
Pasting those back spends exactly what the subagent was there to save.

What a subagent cannot do is hand over the keyboard. A login, a CAPTCHA, or an OS-level
block needs the human, and the human is not reading that context. It should return a handoff
request — what is on screen, what the user has to do — and let this conversation stage the
`show`.

### Readiness
Before driving, make sure the method's tools are installed and the kernel is up. Each
reference lists its install line; if a command is missing, install it rather than failing.

## Where to go next

Pick the method from Step 1/2 and open its reference for exact install + drive steps.
`stealth` is the right default for almost anything involving a real, logged-in, or
bot-protected site.
