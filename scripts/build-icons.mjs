// Regenerate the app icons from the SVG sources in this script.
// Run: node scripts/build-icons.mjs
//
// Produces:
//   icons/icon-192.png         — standard PWA icon, dark rounded square
//   icons/icon-512.png         — same, larger
//   icons/icon-maskable.png    — full-bleed background, gem in 80% safe zone
//   favicon.svg                — vector favicon for browser tabs
//
// Requires @resvg/resvg-js, resolved from /tmp/favicon-gen/node_modules (the
// repo intentionally has no package.json — this is a one-shot generator).

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/tmp/favicon-gen/');
const { Resvg } = require('@resvg/resvg-js');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Brand gradient: pink → purple → blue, matching the boot splash gem
// (style.css:143). 135° sweep = top-left to bottom-right.
const GRAD_STOPS = `
  <stop offset="0"   stop-color="#ff5577"/>
  <stop offset="0.5" stop-color="#b14aed"/>
  <stop offset="1"   stop-color="#5468ff"/>
`;

// Standard icon: dark rounded-square background with a centered diamond gem.
// Used for icon-192, icon-512, and favicon.svg.
function standardSVG(size) {
  const cornerRadius = size * 0.22;        // iOS-style rounded square
  const gemSize = size * 0.62;             // gem fills ~62% of canvas
  const gemRadius = gemSize * 0.18;        // rounded gem corners
  const glowBlur = size * 0.06;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1">${GRAD_STOPS}</linearGradient>
    <radialGradient id="bg" cx="0.5" cy="0.45" r="0.7">
      <stop offset="0"   stop-color="#2a1a4a"/>
      <stop offset="0.6" stop-color="#16102e"/>
      <stop offset="1"   stop-color="#0e0a1f"/>
    </radialGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="${glowBlur}"/>
    </filter>
  </defs>

  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="url(#bg)"/>

  <g transform="translate(${size / 2} ${size / 2}) rotate(45)">
    <rect x="${-gemSize / 2}" y="${-gemSize / 2}" width="${gemSize}" height="${gemSize}"
          rx="${gemRadius}" fill="#b14aed" opacity="0.55" filter="url(#glow)"/>
    <rect x="${-gemSize / 2}" y="${-gemSize / 2}" width="${gemSize}" height="${gemSize}"
          rx="${gemRadius}" fill="url(#gem)"/>
    <rect x="${-gemSize / 2}" y="${-gemSize / 2}" width="${gemSize}" height="${gemSize * 0.45}"
          rx="${gemRadius}" fill="url(#shine)"/>
  </g>
</svg>`;
}

// Maskable icon: full-bleed gradient background, gem confined to inner 80%
// safe zone so Android launcher masks don't crop it.
function maskableSVG(size) {
  const gemSize = size * 0.48;             // smaller to stay inside safe zone
  const gemRadius = gemSize * 0.18;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1">${GRAD_STOPS}</linearGradient>
    <radialGradient id="bg" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0"   stop-color="#2a1a4a"/>
      <stop offset="1"   stop-color="#0e0a1f"/>
    </radialGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#ffffff" stop-opacity="0.4"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${size}" height="${size}" fill="url(#bg)"/>

  <g transform="translate(${size / 2} ${size / 2}) rotate(45)">
    <rect x="${-gemSize / 2}" y="${-gemSize / 2}" width="${gemSize}" height="${gemSize}"
          rx="${gemRadius}" fill="url(#gem)"/>
    <rect x="${-gemSize / 2}" y="${-gemSize / 2}" width="${gemSize}" height="${gemSize * 0.45}"
          rx="${gemRadius}" fill="url(#shine)"/>
  </g>
</svg>`;
}

function render(svg, size, outPath) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  writeFileSync(outPath, resvg.render().asPng());
  console.log(`wrote ${outPath}`);
}

// Vector favicon — modern browsers prefer this for the browser tab.
writeFileSync(join(root, 'favicon.svg'), standardSVG(64));
console.log(`wrote ${join(root, 'favicon.svg')}`);

render(standardSVG(192), 192, join(root, 'icons/icon-192.png'));
render(standardSVG(512), 512, join(root, 'icons/icon-512.png'));
render(maskableSVG(512), 512, join(root, 'icons/icon-maskable.png'));
