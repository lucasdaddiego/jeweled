#!/usr/bin/env bash
# Build the Cloudflare Pages publish directory.
#
# Copies only the files that should be public-facing into dist/, excluding
# repo metadata and dev tooling (.claude/, scripts/). Cloudflare Pages serves
# whatever is in pages_build_output_dir at the site root, so anything outside
# dist/ stays private to the repo.
#
# Also stamps the current commit SHA into the service-worker cache key and
# the BUILD constant. In CI this comes from $GITHUB_SHA; locally it falls
# back to `git rev-parse HEAD`. Both code paths produce a real identifier so
# we never ship 'dev' to a deployed site.
#
# Local: bash scripts/build.sh && wrangler pages dev dist
# Deploy: bash scripts/build.sh && wrangler pages deploy dist
# Cloudflare dashboard: set the Build command to `bash scripts/build.sh`
#                       and the Build output directory to `dist`.

set -euo pipefail
cd "$(dirname "$0")/.."

# Wipe and recreate so deletions in source propagate to the publish dir.
rm -rf dist
mkdir -p dist

# Files at the publish root.
cp index.html style.css manifest.json sw.js _headers favicon.svg dist/

# Directories — copy recursively, preserving the layout the service worker's
# precache list (sw.js) and runtime fetch URLs depend on.
cp -R icons dist/
cp -R src dist/

# Stamp commit SHA into the service-worker cache key + the BUILD constant.
# CI provides $GITHUB_SHA; locally we read it from git. The script fails loud
# if neither is available rather than silently shipping 'dev' to a deploy.
SHA_FULL="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
if [ -z "$SHA_FULL" ]; then
  echo "Error: no commit SHA available (set GITHUB_SHA or run inside a git repo)." >&2
  exit 1
fi
SHA8="${SHA_FULL:0:8}"

# BSD/GNU sed compatibility: -i.bak then rm works on both macOS and Linux.
sed -i.bak "s/^const CACHE = 'gem-match-v\([0-9]*\)';$/const CACHE = 'gem-match-v\1-${SHA8}';/" dist/sw.js
rm -f dist/sw.js.bak
grep -q "^const CACHE = 'gem-match-v[0-9]*-${SHA8}';\$" dist/sw.js || {
  echo "Error: SW cache key stamp did not apply. Check sw.js CACHE line format." >&2
  exit 1
}

sed -i.bak "s/^export const BUILD = '.*';$/export const BUILD = '${SHA8}';/" dist/src/build.js
rm -f dist/src/build.js.bak
grep -q "^export const BUILD = '${SHA8}';\$" dist/src/build.js || {
  echo "Error: BUILD constant stamp did not apply. Check src/build.js format." >&2
  exit 1
}

# Guard: the SW precache list must name every module in src/ — a new module
# that isn't listed silently breaks offline-from-source (dev/self-hosters).
# Compare the sorted '/src/...' entries in sw.js against the actual tree.
# sort -u: '/src/main.js' legitimately appears twice (PRECACHE + MAIN_ENTRY).
PRECACHE_SRC=$(grep -oE "'/src/[^']+'" sw.js | tr -d "'" | sort -u)
ACTUAL_SRC=$( (cd . && find src -type f -name '*.js' | sed 's|^|/|') | sort)
if [ "$PRECACHE_SRC" != "$ACTUAL_SRC" ]; then
  echo "Error: sw.js PRECACHE is out of sync with src/:" >&2
  diff <(echo "$PRECACHE_SRC") <(echo "$ACTUAL_SRC") >&2 || true
  exit 1
fi

# A real 404 page. Its presence switches Cloudflare Pages from SPA fallback
# (which soft-200s every unknown path with the app shell) to true 404s —
# _redirects "404" status rules are silently unsupported by Pages, so this
# file IS the not-found defense.
cat > dist/404.html <<'EOF'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 — Jeweled</title>
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0e0a1f;color:#f3f0ff;font-family:-apple-system,system-ui,sans-serif}a{color:#d59bff}</style></head>
<body><h1>404</h1><p>Nothing here. <a href="/">Play Jeweled instead?</a></p></body>
</html>
EOF

# Legacy _redirects kept only as documentation of intent; Pages ignores 404
# status rules, so dist/404.html above is the actual mechanism.
cat > dist/_redirects <<'EOF'
# (intentionally empty — see dist/404.html; Pages does not support 404-status
# rules in this file, so unknown paths 404 via the presence of 404.html)
EOF

echo "Built dist/ ($(du -sh dist | cut -f1)) — build $SHA8"
