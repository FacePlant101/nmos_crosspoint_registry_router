#!/bin/sh
# Run every unit test. Requires a built server: npm --prefix server run build
# (and `lua` for the Q-SYS script tests).
set -e
cd "$(dirname "$0")/../.."
fail=0
for t in test/unit/*.test.js; do
    echo "--- $t"
    node "$t" || fail=1
    echo
done
# The Q-SYS script runs on Lua; its tests need a local `lua` (Q-SYS uses 5.3).
for t in test/unit/*.test.lua; do
    echo "--- $t"
    if command -v lua >/dev/null 2>&1; then
        lua "$t" || fail=1
    else
        echo "SKIP  lua not installed"
    fi
    echo
done
[ "$fail" = "0" ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
