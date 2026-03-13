#!/usr/bin/env bash
set -euo pipefail

# Deletion Regex Allowlist — Unit tests for the keyword regex pattern
# Tests the regex used in Gate 5 to determine if spec permits large deletions

PASS_COUNT=0
FAIL_COUNT=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Shared regex — must match the pattern in auto-dev.sh Gate 5
DELETION_ALLOWLIST_RE='\b(remove|delete|eliminate|rip out|deprecate|drop|strip|sunset)\b.{0,50}\b(feature|system|module|service|component|logic|code|implementation|class|file|handler|middleware|layer|integration|workflow|subsystem|engine)\b'

assert_match() {
  local test_name="$1" expected="$2" body="$3"
  local actual="no"
  if echo "$body" | grep -qiE "$DELETION_ALLOWLIST_RE"; then
    actual="yes"
  fi

  if [[ "$expected" == "$actual" ]]; then
    echo -e "  ${GREEN}✓${NC} $test_name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "  ${RED}✗${NC} $test_name (expected: $expected, got: $actual)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

echo "Deletion Regex Allowlist Tests"
echo "=============================="

# Case 1: "field" not in noun list — should NOT match
assert_match "Delete unused field cacheKey: NO" "no" "Delete unused field cacheKey"

# Case 2: verb + noun match — should match
assert_match "Remove the caching module entirely: YES" "yes" "Remove the caching module entirely"

# Case 3: compound name within 50 chars — should match
assert_match "Rip out legacy notification-dispatch system: YES" "yes" "Rip out the legacy notification-dispatch system"

# Case 4: known false allowlist (remove...code) — accepted
assert_match "Remove the typo in caching module: YES (false allowlist)" "yes" "Remove the typo in caching module"

# Case 5: long compound within 50 chars — should match
assert_match "Deprecate background-job-scheduling service: YES" "yes" "deprecate and eventually remove the background-job-scheduling service"

# Case 6: "fix" not a deletion verb — should NOT match
assert_match "Fix bug in the service layer: NO" "no" "Fix bug in the service layer"

# Case 7: word boundaries block substring — should NOT match
assert_match "irremovedeprecated system: NO" "no" "irremovedeprecated system"

echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
echo "All tests passed."
