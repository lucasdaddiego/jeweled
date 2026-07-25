// Generate the service-worker precache manifest from the assembled publish
// tree. Keeping discovery here removes the manual src/icons file list while
// preserving deterministic, line-oriented output for the production bundle
// rewrite in deploy.yml.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const publishDir = resolve(process.argv[2] || 'dist');
const swPath = join(publishDir, 'sw.js');
const START = '  // <generated-precache>';
const END = '  // </generated-precache>';
const ALLOWED_EXTENSIONS = new Set(['.css', '.js', '.json', '.png', '.svg']);
const EXCLUDED = new Set(['/index.html', '/sw.js']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile() && ALLOWED_EXTENSIONS.has(extname(entry.name))) out.push(path);
  }
  return out;
}

const discovered = (await walk(publishDir))
  .map((path) => '/' + relative(publishDir, path).split(sep).join('/'))
  .filter((path) => !EXCLUDED.has(path))
  .sort();
// Cache the app shell by its public navigation URL. index.html is deliberately
// omitted as a second alias, and sw.js must always come from the network.
const assets = ['/', ...discovered];
const manifest = [
  START,
  ...assets.map((asset) => `  '${asset}',`),
  END,
].join('\n');

const source = await readFile(swPath, 'utf8');
const startAt = source.indexOf(START);
const endAt = source.indexOf(END);
if (startAt < 0 || endAt < startAt) {
  throw new Error(`precache markers missing or out of order in ${swPath}`);
}
const next = source.slice(0, startAt) + manifest + source.slice(endAt + END.length);
await writeFile(swPath, next);

console.log(`Generated ${assets.length} precache entries in ${relative(process.cwd(), swPath)}`);
