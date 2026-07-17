# cloud — Browserbase / managed browsers (not installed)

Reach for this only when you need scale a laptop can't provide: hundreds of concurrent
browsers, or residential IPs to look like real ISP traffic for large-scale scraping. For one
or a few interactive sessions, local `stealth` / `fast` is simpler and free.

**Not installed / no account configured.** This is a paid, metered service (Browserbase,
Anchor, etc.). Set it up only when a task genuinely needs the scale, and confirm the cost
with the user first.

Once provisioned, these expose a remote CDP endpoint — you still drive with agent-browser
over CDP (`agent-browser connect <ws-url>`), so the operating pattern is the same as local;
only the kernel's location and exit IP change.
