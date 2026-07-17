#!/usr/bin/env bash
#
# Smoke test for the agent-browser integration.
#
# Verifies that agent-browser can drive web-plane's hidden stealth Chrome:
#   cdp -> connect -> navigator.webdriver === false -> navigate/eval ->
#   hide -> still drivable -> close
#
# Requires: web-plane installed (`web-plane install`) and agent-browser on PATH.
# Point WEB_PLANE at a local checkout to test a branch, e.g.
#   WEB_PLANE="node $HOME/Projects/web-plane/bin/web-plane.js" scripts/smoke.sh
#
set -euo pipefail

SESSION="${1:-smoke-$$}"
WP="${WEB_PLANE:-web-plane}"

cleanup() { $WP -s="$SESSION" close >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "-> start hidden session + expose CDP"
OUT="$($WP -s="$SESSION" cdp)"
echo "$OUT" | sed 's/^/   /'
PORT="$(echo "$OUT" | awk '/CDP port:/ {print $3}')"
[ -n "$PORT" ] || { echo "FAIL: no CDP port printed"; exit 1; }

echo "-> agent-browser connect $PORT"
agent-browser connect "$PORT" >/dev/null

WD="$(agent-browser eval 'navigator.webdriver' | tail -1)"
echo "   navigator.webdriver = $WD"
[ "$WD" = "false" ] || { echo "FAIL: expected webdriver=false (stealth broken / not attached)"; exit 1; }

agent-browser goto https://example.com >/dev/null
TITLE="$(agent-browser eval 'document.title' | tail -1)"
echo "   title = $TITLE"
echo "$TITLE" | grep -q "Example Domain" || { echo "FAIL: navigate/eval broken"; exit 1; }

echo "-> hide, then confirm still drivable"
$WP -s="$SESSION" hide >/dev/null
R="$(agent-browser eval '6*7' | tail -1)"
echo "   eval after hide = $R"
[ "$R" = "42" ] || { echo "FAIL: eval broken after hide"; exit 1; }

echo "PASS: agent-browser drives web-plane's hidden stealth Chrome (webdriver=false, works while hidden)"
