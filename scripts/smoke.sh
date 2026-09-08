#!/usr/bin/env bash
#
# Smoke test for the agent-browser integration.
#
# Verifies that agent-browser can drive web-plane's hidden stealth Chrome:
#   cdp -> connect -> navigator.webdriver === false -> navigate/eval ->
#   hide -> still drivable -> close
#
# Requires: web-plane installed (`web-plane install`); its package supplies agent-browser.
# Point WEB_PLANE at a local checkout to test a branch, e.g.
#   WEB_PLANE="node $HOME/Projects/web-plane/bin/web-plane.js" scripts/smoke.sh
#
set -euo pipefail

SESSION="${1:-smoke-$$}"
WP="${WEB_PLANE:-web-plane}"

cleanup() {
  if [ -n "${PORT:-}" ]; then
    $WP agent-browser --session "$SESSION" --cdp "$PORT" close >/dev/null 2>&1 || true
  fi
  $WP -s="$SESSION" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "-> start hidden session + expose CDP"
OUT="$($WP -s="$SESSION" cdp)"
echo "$OUT" | sed 's/^/   /'
PORT="$(echo "$OUT" | awk '/CDP port:/ {print $3}')"
[ -n "$PORT" ] || { echo "FAIL: no CDP port printed"; exit 1; }

echo "-> web-plane agent-browser --session $SESSION --pin-tab connect $PORT"
$WP agent-browser --session "$SESSION" --pin-tab connect "$PORT" >/dev/null

WD="$($WP agent-browser --session "$SESSION" --cdp "$PORT" eval 'navigator.webdriver' | tail -1)"
echo "   navigator.webdriver = $WD"
[ "$WD" = "false" ] || { echo "FAIL: expected webdriver=false (stealth broken / not attached)"; exit 1; }

$WP agent-browser --session "$SESSION" --cdp "$PORT" goto https://example.com >/dev/null
TITLE="$($WP agent-browser --session "$SESSION" --cdp "$PORT" eval 'document.title' | tail -1)"
echo "   title = $TITLE"
echo "$TITLE" | grep -q "Example Domain" || { echo "FAIL: navigate/eval broken"; exit 1; }

echo "-> hide, then confirm still drivable"
$WP -s="$SESSION" hide >/dev/null
R="$($WP agent-browser --session "$SESSION" --cdp "$PORT" eval '6*7' | tail -1)"
echo "   eval after hide = $R"
[ "$R" = "42" ] || { echo "FAIL: eval broken after hide"; exit 1; }

echo "PASS: agent-browser drives web-plane's hidden stealth Chrome (webdriver=false, works while hidden)"
