#!/usr/bin/env bash
# Lint for localization regressions: locale formatting outside i18n.js, native
# browser dialogs, and untranslated data fields. Exits non-zero on any hit.
#
# Uses portable `grep -rE` (no ripgrep dependency) so it runs identically on
# macOS (BSD grep) and Linux CI (GNU grep). Avoids the GNU-only `\b` escape in
# favour of explicit character-class boundaries, and is bash-3.2 safe.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

# Assert a pattern does NOT appear in src/*.js, excluding the given filenames.
check_absent() {
  local label="$1"
  local pattern="$2"
  shift 2
  local excludes=()
  local f
  for f in "$@"; do excludes+=( "--exclude=$f" ); done
  local out
  # ${excludes[@]+...} guards the empty-array expansion under `set -u` on bash 3.2.
  out="$(grep -rnE --include='*.js' ${excludes[@]+"${excludes[@]}"} "$pattern" src || true)"
  if [[ -n "$out" ]]; then
    echo "$label"
    echo "$out"
    fail=1
  fi
}

check_absent "found locale formatting outside src/i18n.js" \
  '\.toLocale(String|DateString|TimeString|LowerCase|UpperCase)?\(' i18n.js
check_absent "found direct native dialogs" \
  'window\.(confirm|alert)\('
check_absent "found untranslated puzzle fields outside puzzle/i18n data" \
  '(^|[^A-Za-z0-9_])puzzle\.(name|hint)([^A-Za-z0-9_]|$)' puzzles.js i18n.js
check_absent "found untranslated achievement fields outside achievement/i18n data" \
  '(^|[^A-Za-z0-9_])a\.(name|desc)([^A-Za-z0-9_]|$)' achievements.js

exit "$fail"
