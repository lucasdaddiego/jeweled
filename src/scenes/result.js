// Shared win/lose/done scene.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import * as dialogs from '../dialogs.js';
import * as sound from '../sound.js';
import * as leaderboard from '../leaderboard.js';
import { shareCard } from '../shareImage.js';
import { buildShareText } from '../dailyMeta.js';
import { setScene } from '../main.js';
import { LEVELS } from '../levels.js';
import { PUZZLES } from '../puzzles.js';

const SITE_URL = 'https://jeweled.daddiego.com.ar';

let args = {};
let buttons = [];
let cursorX = 0, cursorY = 0;
// Daily leaderboard state: null = loading/off, {ok:false} = backend absent
// (block hidden), {ok:true, entries, rank?} = show.
let lb = null;
// Monotonic token so a slow response from a previous result screen can't
// clobber this one's state.
let lbToken = 0;

export function enter(a = {}) {
  args = a || {};
  document.body.className = '';
  buttons = [];
  lb = null;
  // End-of-run audio sting matched to the emotional beat.
  if (args.outcome === 'lose') sound.loseThud();
  else if (args.isNewBest || args.outcome === 'win') sound.winFanfare();
  else sound.milestoneDing();

  // Daily leaderboard: submit the counted run (spoofable, friendly — see
  // functions/api/leaderboard/[date].js), or just fetch on replays. The
  // backend is optional: {ok:false} keeps the block hidden entirely.
  if (args.mode === 'daily' && args.date) {
    const token = ++lbToken;
    const name = storage.getProfile().playerName || 'Player';
    const req = args.isReplay
      ? leaderboard.fetchDaily(args.date)
      : leaderboard.submitDaily(args.date, name, args.score | 0);
    req.then(res => { if (token === lbToken) lb = res; });
  }
}
export function exit() {}
export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  let title = '';
  let subtitle = '';
  if (args.mode === 'classic') {
    if (args.outcome === 'win') {
      title = i18n.t('result.classicWin');
      const n = Math.max(0, Math.min(3, args.stars | 0));   // clamp; '★'.repeat(-1) would throw
      const stars = '★'.repeat(n) + '☆'.repeat(3 - n);
      subtitle = `${stars}\n${i18n.t('result.classicSubtitleWin', { score: i18n.formatNumber(args.score), target: i18n.formatNumber(args.target) })}`;
    } else {
      title = i18n.t('result.classicLose');
      subtitle = i18n.t('result.classicSubtitleLose', { score: i18n.formatNumber(args.score), target: i18n.formatNumber(args.target) });
    }
  } else if (args.mode === 'daily') {
    title = i18n.t('result.dailyHeader', { date: i18n.formatDate(args.date) });
    // isNewBest + prevBest are captured in gameDaily.finalize() *before*
    // bestEver is written to storage, so we don't have to re-derive it (and
    // can't, because by now storage has already been updated).
    const best = args.isNewBest ? args.score : (args.prevBest ?? storage.load().daily.bestEver);
    const bestLine = args.isNewBest
      ? i18n.t('result.newBest')
      : i18n.t('result.bestEver', { score: i18n.formatNumber(best) });
    subtitle = `${i18n.t('result.scorePts', { score: i18n.formatNumber(args.score) })}\n${bestLine}`;
    if ((args.streak || 0) >= 2) subtitle += `\n${i18n.t('daily.streak', { n: args.streak })}`;
  } else if (args.mode === 'blitz') {
    title = i18n.t('result.blitzDone');
    // isNewBest + prevBest are passed in from gameBlitz.finalize() before the
    // bestScore is written to storage, so we don't have to re-derive it.
    const best = args.isNewBest ? args.score : (args.prevBest ?? 0);
    const bestLine = args.isNewBest
      ? i18n.t('result.newBest')
      : i18n.t('result.best', { score: i18n.formatNumber(best) });
    subtitle = `${i18n.t('result.scorePts', { score: i18n.formatNumber(args.score) })}\n${bestLine}`;
  } else if (args.mode === 'puzzle') {
    const p = PUZZLES.find(p => p.id === args.puzzleNum);
    const puzzleName = p ? i18n.t(p.nameKey) : '';
    if (args.outcome === 'win') {
      title = i18n.t('result.puzzleWin');
      subtitle = `${puzzleName}\n${i18n.t('result.scorePts', { score: i18n.formatNumber(args.score) })}`;
    } else {
      title = i18n.t('result.puzzleLose');
      subtitle = `${puzzleName}\n${i18n.t('result.goalNotReached')}`;
    }
  } else {
    title = i18n.t('result.runEnded');
    subtitle = i18n.t('result.scorePts', { score: i18n.formatNumber(args.score) });
  }

  const lines = subtitle.split('\n');
  const actions = buildActions();
  const showLeaderboard = args.mode === 'daily' && lb && lb.ok;
  const leaderboardRows = showLeaderboard
    ? Math.max(1, Math.min(5, (lb.entries || []).length))
    : 0;
  const box = computeResultLayout({
    w,
    h,
    safeTop: render.layout.safeTop,
    subtitleLines: lines.length,
    actionCount: actions.length,
    leaderboardRows,
    hasRank: showLeaderboard && lb.rank != null,
  });

  render.drawText(title, w / 2, box.titleY, {
    font: `bold ${box.titleFont}px -apple-system, system-ui, sans-serif`,
    align: 'center', shadow: true,
  });

  let y = box.subtitleY;
  for (const line of lines) {
    render.drawText(line, w / 2, y, {
      font: line.includes('★')
        ? `bold ${box.starFont}px sans-serif`
        : `${box.subtitleFont}px sans-serif`,
      align: 'center', shadow: true,
      color: line.includes('★') ? '#ffd166' : '#f3f0ff',
    });
    y += box.subtitleStep;
  }

  let ay = box.buttonsY;
  for (const action of actions) {
    drawHitButton(box.buttonX, ay, box.buttonW, box.buttonH, action.label, action.onClick);
    ay += box.buttonH + box.buttonGap;
  }

  // Daily leaderboard block (only when the optional backend answered).
  if (showLeaderboard) drawLeaderboard(w, box.leaderboardY, box.leaderboardStep);
}

function buildActions() {
  const actions = [];
  const add = (label, onClick) => actions.push({ label, onClick });

  if (args.mode === 'classic' && args.outcome === 'win' && args.level < LEVELS.length) {
    add(i18n.t('common.nextLevel'), () => setScene('gameClassic', { level: args.level + 1 }));
  } else if (args.mode === 'classic' && args.outcome === 'lose') {
    add(i18n.t('common.retry'), () => setScene('gameClassic', { level: args.level }));
  } else if (args.mode === 'blitz') {
    add(i18n.t('common.again'), () => setScene('gameBlitz'));
  } else if (args.mode === 'puzzle') {
    if (args.outcome === 'win') {
      const hasNext = args.puzzleNum < PUZZLES.length;
      if (hasNext) {
        add(i18n.t('common.nextPuzzle'), () =>
          setScene('gamePuzzle', { puzzle: args.puzzleNum + 1 }));
      } else {
        add(i18n.t('common.allPuzzles'), () => setScene('puzzleSelect'));
      }
    } else {
      add(i18n.t('common.retry'), () => setScene('gamePuzzle', { puzzle: args.puzzleNum }));
    }
  } else if (args.mode === 'daily') {
    add(i18n.t('common.share'), shareDaily);
    add(i18n.t('result.viewHistory'), () => setScene('dailyHistory'));
  }
  add(i18n.t('common.title'), () => setScene('title'));
  return actions;
}

// Pure geometry helper shared by draw() and viewport-boundary tests. The
// compact profile is deliberately used for 600px-tall desktop windows too:
// Daily can contain three subtitle rows, three buttons, five leaderboard
// entries and a rank, all of which must remain visible without scrolling.
export function computeResultLayout({
  w, h, safeTop = 0, subtitleLines, actionCount, leaderboardRows = 0, hasRank = false,
}) {
  const compact = h < 680 || w < 480;
  const titleFont = compact ? 30 : 36;
  const titleHeight = titleFont + 8;
  const subtitleFont = compact ? 18 : 20;
  const starFont = compact ? 30 : 36;
  const subtitleStep = compact ? 30 : 40;
  const buttonH = compact ? 42 : 50;
  const buttonGap = compact ? 8 : 14;
  const leaderboardStep = compact ? 18 : 20;
  const buttonW = Math.min(200, Math.max(120, w - 32));
  const subtitleGap = 8;
  const actionGap = compact ? 14 : 24;
  const leaderboardGap = compact ? 12 : 18;
  const buttonBlock = actionCount * buttonH + Math.max(0, actionCount - 1) * buttonGap;
  const leaderboardBlock = leaderboardRows > 0
    ? 26 + leaderboardRows * leaderboardStep + (hasRank ? 18 : 0)
    : 0;
  const contentHeight = titleHeight + subtitleGap + subtitleLines * subtitleStep
    + actionGap + buttonBlock
    + (leaderboardBlock ? leaderboardGap + leaderboardBlock : 0);
  const top = Math.max(safeTop + 12, (h - contentHeight) / 2);
  const subtitleY = top + titleHeight + subtitleGap;
  const buttonsY = subtitleY + subtitleLines * subtitleStep + actionGap;
  const leaderboardY = buttonsY + buttonBlock + leaderboardGap;

  return {
    titleY: top,
    subtitleY,
    buttonsY,
    leaderboardY,
    bottom: top + contentHeight,
    buttonX: w / 2 - buttonW / 2,
    buttonW,
    buttonH,
    buttonGap,
    titleFont,
    subtitleFont,
    starFont,
    subtitleStep,
    leaderboardStep,
  };
}

function drawLeaderboard(w, y, rowStep) {
  const ctx = render.ctxRef();
  render.drawText(i18n.t('leaderboard.title'), w / 2, y, {
    font: 'bold 16px sans-serif', align: 'center', color: '#ffd166', shadow: true,
  });
  y += 26;
  const entries = (lb.entries || []).slice(0, 5);
  if (entries.length === 0) {
    render.drawText(i18n.t('leaderboard.empty'), w / 2, y, {
      font: '14px sans-serif', align: 'center', color: 'rgba(255,255,255,0.7)',
    });
    y += 22;
  } else {
    ctx.save();
    ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < entries.length; i++) {
      ctx.fillStyle = i === 0 ? '#ffd166' : 'rgba(255,255,255,0.85)';
      ctx.fillText(`${i + 1}. ${entries[i].name} — ${i18n.formatNumber(entries[i].score)}`, w / 2, y);
      y += rowStep;
    }
    ctx.restore();
  }
  if (lb.rank != null) {
    render.drawText(i18n.t('leaderboard.rank', { rank: lb.rank }), w / 2, y + 2, {
      font: '13px sans-serif', align: 'center', color: 'rgba(255,255,255,0.6)',
    });
  }
}

async function shareDaily() {
  const text = buildShareText({
    dateLabel: i18n.formatDate(args.date),
    score: i18n.formatNumber(args.score),
    movesUsed: args.movesUsed ?? null,
    streak: args.streak || 0,
    url: SITE_URL,
  });
  const lines = [
    i18n.formatDate(args.date),
    i18n.t('result.scorePts', { score: i18n.formatNumber(args.score) }),
  ];
  if ((args.streak || 0) >= 2) lines.push(i18n.t('daily.streak', { n: args.streak }));
  const outcome = await shareCard(
    { title: 'Jeweled Daily', lines, footer: SITE_URL },
    text,
  );
  if (outcome === 'copied') {
    await dialogs.alert(i18n.t('common.copiedToClipboard'));
  }
}

function drawHitButton(x, y, w, h, label, onClick) {
  render.drawHitButton(x, y, w, h, label, onClick, buttons, cursorX, cursorY);
}

export function onPointer(evt) {
  if (evt.type !== 'down') return;
  for (const b of buttons) {
    if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
      b.onClick();
      return;
    }
  }
}

export function onMove(x, y) { cursorX = x; cursorY = y; }
