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

# Defense-in-depth: 404 any path that should never have been published, even
# if a future change accidentally adds .claude/ or scripts/ to dist/. Belt
# and suspenders alongside the dist/-only output dir.
cat > dist/_redirects <<'EOF'
# Edge 404s for paths that must never be public. These guard against a future
# change accidentally copying dev tooling into the publish dir; the primary
# protection is that scripts/build.sh simply doesn't copy them.
/.claude/* /404 404
/scripts/* /404 404
/wrangler.jsonc /404 404
/.gitignore /404 404
EOF

echo "Built dist/ ($(du -sh dist | cut -f1)) — build $SHA8"
