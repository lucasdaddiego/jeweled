// Share card: paints a branded 640×400 result card on an OffscreenCanvas and
// hands it to the Web Share API as a PNG, degrading gracefully — image share →
// text share → clipboard — and reporting which rung actually ran so the caller
// can word its confirmation accordingly.
//
// Pure presentation: the caller passes already-localized strings; nothing here
// reads game state. Kept dependency-free (like painting.js) — importing
// render.js just for roundRect would drag the whole render stack (and its
// main.js circularity) into the module graph, so a tiny local copy lives here.

const CARD_W = 640;
const CARD_H = 400;
const FONT = '-apple-system, system-ui, sans-serif';

// Brand palette: dark purple panel + the pink → purple → blue accent gradient
// used across the app chrome.
const BG = '#1a1530';
const ACCENT_STOPS = [[0, '#ff9ec0'], [0.5, '#d59bff'], [1, '#8fd1ff']];

// Share `shareText`, leading with a rendered card image when the platform can
// take one. Resolves to exactly one of:
//   'shared-image' — card PNG went through the share sheet
//   'shared-text'  — text-only share sheet
//   'copied'       — clipboard fallback
//   'canceled'     — the user dismissed a share sheet on purpose
//   'unavailable'  — no share surface at all
// Never rejects — every rung is individually exception-safe.
export async function shareCard(card, shareText) {
  const { title = '', lines = [], footer = '' } = card || {};

  // (a) Image share. Only worth rendering when the whole pipeline could work:
  // OffscreenCanvas (jsdom / older WebKit lack it), the File constructor, and
  // a share sheet that accepts file payloads.
  if (typeof OffscreenCanvas !== 'undefined' && typeof File !== 'undefined' &&
      navigator.canShare && navigator.share) {
    let file = null;
    try {
      const blob = await renderCard(title, lines, footer).convertToBlob({ type: 'image/png' });
      const f = new File([blob], 'jeweled.png', { type: 'image/png' });
      // canShare probes file-payload support without opening the sheet.
      if (navigator.canShare({ files: [f] })) file = f;
    } catch {
      // Rendering/encode failed (or canShare itself blew up) — the text-only
      // rungs below still give the user something to share.
    }
    if (file) {
      try {
        // Brand name stays English in the share sheet title.
        await navigator.share({ files: [file], text: shareText, title: 'Jeweled' });
        return 'shared-image';
      } catch (err) {
        // AbortError = the user dismissed the sheet on purpose; pushing the
        // text onto their clipboard next would second-guess that choice.
        if (isAbort(err)) return 'canceled';
        // The sheet itself failed (permissions, transient-activation loss…) —
        // don't pop a second sheet; quietly fall back to the clipboard.
        return copyFallback(shareText);
      }
    }
  }

  // (b) Text-only share.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Jeweled', text: shareText });
      return 'shared-text';
    } catch (err) {
      if (isAbort(err)) return 'canceled';
      // Real failure — fall through to the clipboard.
    }
  }

  // (c)/(d) Clipboard, or nothing at all.
  return copyFallback(shareText);
}

// The user closing a share sheet surfaces as a DOMException named AbortError;
// anything else (including a reason-less rejection) is a real failure.
function isAbort(err) {
  return err?.name === 'AbortError';
}

async function copyFallback(shareText) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareText);
      return 'copied';
    }
  } catch {
    // Clipboard permission denied — nothing left to try.
  }
  return 'unavailable';
}

// Paint the 640×400 card and return the OffscreenCanvas.
function renderCard(title, lines, footer) {
  const canvas = new OffscreenCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');

  // Panel: solid brand-dark rounded rect. The PNG keeps the corners
  // transparent, so the card still reads as a card in messaging previews.
  roundRect(ctx, 0, 0, CARD_W, CARD_H, 28);
  ctx.fillStyle = BG;
  ctx.fill();
  // Hairline border lifts the panel off both light and dark chat backgrounds.
  roundRect(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 27);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Title with a soft drop shadow (mirrors render.drawText's shadow option).
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#f3f0ff';
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(String(title), CARD_W / 2, 88);
  ctx.restore();

  // Brand accent bar under the title: pink → purple → blue.
  const barW = 180, barH = 6;
  const bar = ctx.createLinearGradient(CARD_W / 2 - barW / 2, 0, CARD_W / 2 + barW / 2, 0);
  for (const [offset, color] of ACCENT_STOPS) bar.addColorStop(offset, color);
  roundRect(ctx, CARD_W / 2 - barW / 2, 124, barW, barH, barH / 2);
  ctx.fillStyle = bar;
  ctx.fill();

  // Body lines at descending sizes — the first line (usually the score)
  // dominates and later context lines shrink beneath it, clamped so a deep
  // stack stays readable instead of vanishing.
  let y = 178;
  for (let i = 0; i < lines.length; i++) {
    const size = Math.max(16, 34 - i * 6);          // 34, 28, 22, 16, 16, …
    ctx.font = (i === 0 ? 'bold ' : '') + size + 'px ' + FONT;
    ctx.fillStyle = i === 0 ? '#ffffff' : 'rgba(243, 240, 255, 0.78)';
    ctx.fillText(String(lines[i]), CARD_W / 2, y);
    y += size + 16;
  }

  // Footer: small + dim, pinned to the bottom (the site URL, usually).
  ctx.font = `15px ${FONT}`;
  ctx.fillStyle = 'rgba(243, 240, 255, 0.45)';
  ctx.fillText(String(footer), CARD_W / 2, CARD_H - 34);

  return canvas;
}

// Local copy of render.roundRect (see header for why it isn't imported).
// Radius clamped to half the shortest side so the curves never overlap and
// malform the path on thin shapes like the accent bar.
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
