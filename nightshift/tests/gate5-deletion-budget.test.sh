#!/usr/bin/env bash
set -euo pipefail

# Gate 5: Deletion Budget — Boundary condition tests
# Tests the deletion budget gate logic extracted from auto-dev.sh

PASS_COUNT=0
FAIL_COUNT=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo -e "  ${GREEN}✓${NC} $test_name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "  ${RED}✗${NC} $test_name (expected: $expected, got: $actual)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ---------------------------------------------------------------------------
# Extracted gate logic (mirrors auto-dev.sh Gate 5)
# ---------------------------------------------------------------------------

# Regex: does the spec describe large-scale removal? (verb + noun within 50 chars)
DELETION_ALLOWLIST_RE='\b(remove|delete|eliminate|rip out|deprecate|drop|strip|sunset)\b.{0,50}\b(feature|system|module|service|component|logic|implementation|class|file|handler|middleware|layer|integration|workflow|subsystem|engine)\b'

run_deletion_gate() {
  local lines_deleted="${1:-0}" lines_changed="${2:-0}" body="$3"

  # Guard against empty strings
  lines_deleted="${lines_deleted:-0}"
  lines_changed="${lines_changed:-0}"

  local net_deletions=$(( lines_deleted - lines_changed ))
  if [[ "$net_deletions" -lt 0 ]]; then
    net_deletions=0
  fi

  local blocked=false

  # Check 1: Net deletions
  if [[ "$net_deletions" -gt 15 ]]; then
    if ! echo "$body" | grep -qiE "$DELETION_ALLOWLIST_RE"; then
      blocked=true
    fi
  fi

  # Check 2: Gross deletions
  if [[ "$blocked" == "false" && "$lines_deleted" -gt 40 ]]; then
    if ! echo "$body" | grep -qiE "$DELETION_ALLOWLIST_RE"; then
      blocked=true
    fi
  fi

  echo "$blocked"
}

# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------
echo "Gate 5: Deletion Budget Tests"
echo "=============================="

# Case 1: Pure addition (net=0)
result=$(run_deletion_gate "0" "50" "add a new feature")
assert_eq "Pure addition: PASS (net=0)" "false" "$result"

# Case 2: Normal field removal (net=3)
result=$(run_deletion_gate "5" "2" "remove field cacheKey")
assert_eq "Normal field removal: PASS (net=3)" "false" "$result"

# Case 3: At net threshold (net=15, exactly at limit)
result=$(run_deletion_gate "15" "0" "fix typo")
assert_eq "At net threshold: PASS (net=15)" "false" "$result"

# Case 4: 1 over net threshold (net=16)
result=$(run_deletion_gate "16" "0" "fix typo")
assert_eq "Over net threshold: FAIL (net=16)" "true" "$result"

# Case 5: Over threshold but spec permits (keyword match)
result=$(run_deletion_gate "30" "0" "remove the caching module entirely")
assert_eq "Over threshold, spec permits: PASS" "false" "$result"

# Case 6: Evasion — verbose replacement (gross=41, net=16 triggers net gate; but also gross>40)
result=$(run_deletion_gate "41" "25" "remove field")
assert_eq "Evasion verbose replacement: FAIL (gross=41)" "true" "$result"

# Case 7: Evasion attempt — "code" removed from noun list, now correctly blocked
result=$(run_deletion_gate "41" "25" "remove the typo in code")
assert_eq "Evasion with 'code' (no longer in noun list): FAIL" "true" "$result"

# Case 8: Empty LINES_DELETED (defensive guard)
result=$(run_deletion_gate "" "5" "any body")
assert_eq "Empty LINES_DELETED: PASS (defensive guard)" "false" "$result"

# Case 9: Equal refactor (net=0)
result=$(run_deletion_gate "20" "20" "refactor module")
assert_eq "Equal refactor: PASS (net=0)" "false" "$result"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
echo "All tests passed."
