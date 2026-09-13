// Build identifier shown in the title scene footer and useful when filing
// bug reports. scripts/build.sh rewrites the 'dev' literal below to the short
// commit SHA in dist/src/build.js on every build (CI passes $GITHUB_SHA, a
// local build reads git). The source stays 'dev' so an unbuilt checkout is
// obvious.
export const BUILD = 'dev';
