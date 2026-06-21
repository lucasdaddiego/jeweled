# Jeweled

A polished match-3 puzzle game — **Zen, Classic, Daily, Blitz, and Puzzles**.
Built as a fast, offline-capable PWA with vanilla JavaScript and an HTML Canvas
renderer — no framework, no runtime dependencies.

🎮 **Play it live:** https://jeweled.daddiego.com.ar

![Jeweled](icons/icon-512.png)

## Game modes

| Mode | What it is |
| --- | --- |
| **Classic** | Level-based progression — hit the score target before you run out of moves. |
| **Blitz** | 60-second score attack. Cascade fast, chain specials, beat your best. |
| **Zen** | Endless, no fail state. A relaxed board you can put down and resume — the run auto-saves. |
| **Daily** | One deterministic board per day (seeded from the date), 30 moves, max score. Everyone gets the same puzzle. |
| **Puzzles** | Hand-crafted puzzle boards with set solutions. |

Plus special gems (line clears, color bombs, fire, lightning, star, wildcard…),
spendable power-ups, an achievements system, a streak/play-history heatmap, and
full English/Spanish localization.

## Tech stack

- **Vanilla JavaScript** (ES modules) — zero runtime dependencies.
- **HTML Canvas 2D** for the entire renderer (gems, particles, waves, bolts, floaters).
- **PWA**: installable, works offline via a service worker with a SHA-versioned cache; web app manifest with maskable icons.
- **Persistence**: `localStorage` behind a small versioned-schema wrapper with forward migrations (`src/storage.js`).
- **i18n**: `en` / `es` with auto-detection (`src/i18n.js`).
- **Hosting**: Cloudflare Pages, auto-deployed from `main` via GitHub Actions.

## Run locally

There is **no build step for development** — the app loads its ES-module
entrypoint (`src/main.js`) directly. Just serve the repo root over HTTP:

```bash
npm run serve          # → npx serve . (correct module MIME types)
# then open http://localhost:3000
```

Any static server works as long as it serves `.js` with a JavaScript MIME type.
A quick alternative (note: some older Python builds serve `.js` as `text/plain`,
which browsers reject for modules):

```bash
python3 -m http.server 8080
```

## Build & deploy

```bash
npm install            # dev tools only (esbuild, html-minifier-terser, wrangler)
npm run build          # assemble + SHA-stamp dist/ via scripts/build.sh
npx wrangler pages dev dist     # preview the built output locally
```

Production deploys are automatic: **push to `main`** and the
[`deploy.yml`](.github/workflows/deploy.yml) workflow assembles `dist/`,
bundles `src/` into one minified ES module with esbuild, minifies CSS/HTML/SW,
syntax-checks the output, and ships it to Cloudflare Pages.

To deploy manually you need a Cloudflare API token and account id:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run deploy
```

In CI these are provided as the repo secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

## Project structure

```
index.html          App shell + boot splash; loads src/main.js as a module
style.css           Splash / full-bleed canvas styling
manifest.json       PWA manifest
sw.js               Service worker (precache + offline + cache versioning)
_headers            Cloudflare security headers (CSP, X-Frame-Options, …)
wrangler.jsonc      Cloudflare Pages config (publishes dist/)
src/
  main.js           Boot, scene loop, SW registration
  config.js         Game constants & tunables
  cascade.js        Core match/clear/refill state machine
  grid.js matcher.js specials.js powerups.js   Board + match logic
  render.js animations.js particles.js waves.js bolts.js floaters.js   Canvas rendering & FX
  scenes/           One module per screen (title, game modes, result, stats, …)
  storage.js i18n.js achievements.js …         Persistence, localization, meta
icons/              App icons + locally-bundled Fluent emoji (see credits)
scripts/
  build.sh          Assemble dist/ and stamp the commit SHA
  build-icons.mjs   Regenerate app icons/favicon from inline SVG
  i18n-audit.sh     Lint for untranslated strings / native dialogs
```

## npm scripts

| Script | Does |
| --- | --- |
| `npm run serve` | Serve the repo root for local dev (unbundled). |
| `npm run build` | Build the Cloudflare Pages output into `dist/`. |
| `npm run deploy` | Build, then `wrangler pages deploy dist`. |
| `npm run audit:i18n` | Check for localization regressions. |
| `npm run icons` | Regenerate icons (needs `cd scripts && npm install` once — see script header). |
| `npm run check` | `node --check` every `src/*.js`. |

## Contributing

Issues and PRs are welcome. If you touch user-facing strings, run
`npm run audit:i18n` first — it flags untranslated text and native dialogs.

## License

[MIT](LICENSE) © Lucas Daddiego.

### Credits

- Emoji glyphs are **[Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)**, MIT-licensed, bundled locally under `icons/emoji/` (see [`icons/emoji/LICENSE`](icons/emoji/LICENSE)).
