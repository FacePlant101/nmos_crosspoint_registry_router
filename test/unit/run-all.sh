#!/bin/sh
# Run every unit test. Requires a built server: npm --prefix server run build
set -e
cd "$(dirname "$0")/../.."
fail=0
for t in test/unit/*.test.js; do
    echo "--- $t"
    node "$t" || fail=1
    echo
done
[ "$fail" = "0" ] && echo "all suites passed" || echo "SOME SUITES FAILED"
exit $fail
