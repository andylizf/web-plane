#!/usr/bin/env bash
# Does starting a hidden web-plane session take focus away from the user?
#
# Run it once before a fix and once after, with the same label discipline, and
# the two logs are directly comparable. The verdict is not "did a window
# appear" — a cloaked window is invisible and still leaves its application
# frontmost, which is what a user actually feels. The verdict is whether any
# Chrome activation event exists between session start and session close.
#
# Usage: tests/focus-steal.sh <label>     e.g. baseline | fixed
set -uo pipefail

cd "$(dirname "$0")/.."
LABEL="${1:?usage: focus-steal.sh <label>}"
STAMP="$(date +%Y%m%dT%H%M%S)"
LOG="logs/focus-${LABEL}-${STAMP}.jsonl"
PROFILE="probe"
LANE="focustest"
URL="about:blank"

mkdir -p logs

command -v ./tests/native/focusmon >/dev/null 2>&1 || \
  cc -Wall -Werror -framework AppKit -framework Foundation \
     -o tests/native/focusmon tests/native/focusmon.m

echo "==> log: ${LOG}"

# Clear anything left over, so an activation we record belongs to this run.
web-plane -s="${PROFILE}" close >/dev/null 2>&1 || true

./tests/native/focusmon > "${LOG}" 2>/dev/null &
MON=$!
# Give the observer time to register and write its baseline before anything
# else moves; a missing baseline makes the log unreadable.
until grep -q '"event":"baseline"' "${LOG}" 2>/dev/null; do
  kill -0 "${MON}" 2>/dev/null || { echo "focusmon died before baseline"; exit 1; }
done

echo "==> starting session (this is the moment under test)"
web-plane -s="${PROFILE}" attach --as "${LANE}" "${URL}" >/dev/null 2>&1
RC=$?
echo "==> attach rc=${RC}"

# A dead browser produces a perfectly clean focus log, which is how a patch that
# killed Chrome outright once passed this test three times in a row. Liveness is
# therefore part of the verdict, not a separate concern: no live process means
# the run proves nothing either way.
ALIVE="$(pgrep -f '\.web-plane/Chrome\.app/Contents/MacOS/Google Chrome' | tr '\n' ' ')"
echo "==> browser pids: ${ALIVE:-<none>}"

# Close immediately: the question is what the launch does, and every extra
# second the browser stays up is another second it can disturb the user.
web-plane -s="${PROFILE}" close >/dev/null 2>&1 || true

kill "${MON}" 2>/dev/null
wait "${MON}" 2>/dev/null

echo
echo "=== focus events recorded ==="
cat "${LOG}"
echo
echo "=== verdict ==="
if grep -qE "\"event\":\"(activate|poll-front)\".*[Cc]hrome" "${LOG}"; then
  echo "FOCUS STOLEN — Chrome became frontmost during the run:"
  grep -E "\"event\":\"(activate|poll-front)\".*[Cc]hrome" "${LOG}" | sed 's/^/  /'
  exit 1
elif [ -z "${ALIVE}" ]; then
  echo "INVALID — no browser was alive, so a clean log means nothing"
  exit 2
else
  echo "FOCUS CLEAN — browser alive (${ALIVE}), no Chrome activation recorded"
  exit 0
fi
