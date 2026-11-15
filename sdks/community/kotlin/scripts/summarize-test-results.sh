#!/usr/bin/env bash
# Summarizes JUnit XML results and fails when any test failed or no test ran.
# Usage: summarize-test-results.sh <module>/<task>... (run from sdks/community/kotlin/library)
set -uo pipefail

echo "## Kotlin SDK Test Results Summary"
echo ""

total_tests=0
total_failures=0
total_errors=0

for result in "$@"; do
  module="${result%%/*}"
  task="${result#*/}"
  xml_dir="$module/build/test-results/$task"

  if [ -d "$xml_dir" ]; then
    # Sum up test counts from all XML files in the directory
    module_tests=$(find "$xml_dir" -name "*.xml" -exec grep -h '<testsuite' {} \; | grep -o 'tests="[0-9]*"' | sed 's/tests="\([0-9]*\)"/\1/' | awk '{sum += $1} END {print sum}')
    module_failures=$(find "$xml_dir" -name "*.xml" -exec grep -h '<testsuite' {} \; | grep -o 'failures="[0-9]*"' | sed 's/failures="\([0-9]*\)"/\1/' | awk '{sum += $1} END {print sum}')
    module_errors=$(find "$xml_dir" -name "*.xml" -exec grep -h '<testsuite' {} \; | grep -o 'errors="[0-9]*"' | sed 's/errors="\([0-9]*\)"/\1/' | awk '{sum += $1} END {print sum}')

    # Default to 0 if empty
    module_tests=${module_tests:-0}
    module_failures=${module_failures:-0}
    module_errors=${module_errors:-0}

    if [ "$module_tests" -gt 0 ]; then
      echo "✅ kotlin-$module ($task): $module_tests tests, $module_failures failures, $module_errors errors"
      total_tests=$((total_tests + module_tests))
      total_failures=$((total_failures + module_failures))
      total_errors=$((total_errors + module_errors))
    fi
  fi
done

echo ""
echo "---"
echo "### Overall Results: $total_tests tests, $total_failures failures, $total_errors errors"

if [ $total_failures -gt 0 ] || [ $total_errors -gt 0 ]; then
  echo "❌ Some tests failed"
  exit 1
elif [ $total_tests -eq 0 ]; then
  echo "⚠️ No tests were found or executed"
  exit 1
else
  echo "✅ All $total_tests tests passed!"
fi
