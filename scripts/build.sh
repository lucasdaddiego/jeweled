#!/usr/bin/env bash
# Build the Cloudflare Pages publish directory.
#
# Copies only the files that should be public-facing into dist/, excluding
# repo metadata, dev tooling (.claude/, scripts/), and dev-only test pages
# (emoji-sample.html). Cloudflare Pages serves whatever is in
# pages_build_output_dir at the site root, so anything outside dist/ stays
# private to the repo.
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
cp index.html style.css manifest.json sw.js _headers dist/

# Directories — copy recursively, preserving the layout the service worker's
# precache list (sw.js) and runtime fetch URLs depend on.
cp -R icons dist/
cp -R src dist/

# Defense-in-depth: 404 any path that should never have been published, even
# if a future change accidentally adds .claude/ or scripts/ to dist/. Belt
# and suspenders alongside the dist/-only output dir.
cat > dist/_redirects <<'EOF'
# Edge 404s for paths that must never be public. These guard against a future
# change accidentally copying dev tooling into the publish dir; the primary
# protection is that scripts/build.sh simply doesn't copy them.
/.claude/* /404 404
/scripts/* /404 404
/emoji-sample.html /404 404
/wrangler.jsonc /404 404
/.gitignore /404 404
EOF

echo "Built dist/ ($(du -sh dist | cut -f1))"
