# computer-use — pixel-level driving

Use only when there's no DOM to work with: a native desktop app, a `<canvas>` game, or a
page deliberately obfuscated so snapshots/refs are useless. It drives by screenshots +
mouse/keyboard, so it's slow and brittle compared to CDP methods — reach for a browser
kernel (`fast` / `stealth`) whenever the target is a normal web page.

Computer-use is exposed as MCP tools (`mcp__computer-use__*`), not a CLI. Load them via
ToolSearch (`query: "computer-use", max_results: 30`), then `request_access` for the apps
you need before acting.

Notes:
- Browsers are granted at a restricted "read" tier — visible in screenshots but clicks and
  typing are blocked. For web pages use a CDP method or the Chrome extension MCP, not pixel
  clicks.
- Never click links from emails/messages with pixel tools; open URLs through a browser
  method and verify the destination first.
- Financial actions (trades, transfers, sending money) are always handed to the human.
