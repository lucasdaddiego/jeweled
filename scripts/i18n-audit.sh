#!/usr/bin/env bash
set -euo pipefail

fail=0

check_absent() {
  local label="$1"
  local pattern="$2"
  shift 2
  local out
  out="$(rg -n "$@" "$pattern" src || true)"
  if [[ -n "$out" ]]; then
    echo "$label"
    echo "$out"
    fail=1
  fi
}

check_absent "found locale formatting outside src/i18n.js" '\.toLocale(String|DateString|TimeString|DateString|LowerCase|UpperCase)?\(' -g '!i18n.js'
check_absent "found direct native dialogs" 'window\.(confirm|alert)\('
check_absent "found untranslated puzzle fields outside puzzle/i18n data" '\bpuzzle\.(name|hint)\b' -g '!puzzles.js' -g '!i18n.js'
check_absent "found untranslated achievement fields outside achievement/i18n data" '\ba\.(name|desc)\b' -g '!achievements.js'

exit "$fail"
