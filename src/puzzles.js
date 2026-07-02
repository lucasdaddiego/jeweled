// Hand-designed Puzzle mode challenges. Each has a goal + move budget.
// Puzzles 1-12 use seeded-random boards; 13+ carry a hand-laid `board`
// (8 rows of 8 type digits) with a designed solution. Authored boards are
// verified by tests: no pre-existing matches and at least one valid move.
//
// `nameKey` and `hintKey` resolve through i18n at draw time so display strings
// stay out of the data file. The IDs themselves remain neutral so save-state
// is language-independent.

import { SPECIAL } from './config.js';

// Goal types (handlers in gamePuzzle):
//   { type: 'clearGemsOfColor', color: 0..6, count: N }       — clear N gems of a specific color
//   { type: 'totalScore', amount: N }                          — reach score N
//   { type: 'createSpecial', special: SPECIAL.*, count: N }    — spawn N of a special type
//   { type: 'cascadeDepth', depth: N }                         — trigger a cascade of depth N+

export const PUZZLES = [
  { id: 1,  nameKey: 'puzzle.1.name',  hintKey: 'puzzle.1.hint',  moves: 10, goal: { type: 'totalScore',         amount: 200 } },
  { id: 2,  nameKey: 'puzzle.2.name',  hintKey: 'puzzle.2.hint',  moves: 8,  goal: { type: 'clearGemsOfColor',   color: 0, count: 10 } },
  { id: 3,  nameKey: 'puzzle.3.name',  hintKey: 'puzzle.3.hint',  moves: 8,  goal: { type: 'clearGemsOfColor',   color: 1, count: 12 } },
  { id: 4,  nameKey: 'puzzle.4.name',  hintKey: 'puzzle.4.hint',  moves: 12, goal: { type: 'createSpecial',      special: SPECIAL.LINE_H, count: 2 } },
  { id: 5,  nameKey: 'puzzle.5.name',  hintKey: 'puzzle.5.hint',  moves: 8,  goal: { type: 'cascadeDepth',       depth: 2 } },
  { id: 6,  nameKey: 'puzzle.6.name',  hintKey: 'puzzle.6.hint',  moves: 10, goal: { type: 'totalScore',         amount: 1500 } },
  { id: 7,  nameKey: 'puzzle.7.name',  hintKey: 'puzzle.7.hint',  moves: 15, goal: { type: 'createSpecial',      special: SPECIAL.AREA_BOMB, count: 1 } },
  { id: 8,  nameKey: 'puzzle.8.name',  hintKey: 'puzzle.8.hint',  moves: 12, goal: { type: 'clearGemsOfColor',   color: 4, count: 15 } },
  { id: 9,  nameKey: 'puzzle.9.name',  hintKey: 'puzzle.9.hint',  moves: 18, goal: { type: 'createSpecial',      special: SPECIAL.COLOR_BOMB, count: 1 } },
  { id: 10, nameKey: 'puzzle.10.name', hintKey: 'puzzle.10.hint', moves: 8,  goal: { type: 'cascadeDepth',       depth: 3 } },
  { id: 11, nameKey: 'puzzle.11.name', hintKey: 'puzzle.11.hint', moves: 20, goal: { type: 'totalScore',         amount: 5000 } },
  { id: 12, nameKey: 'puzzle.12.name', hintKey: 'puzzle.12.hint', moves: 10, goal: { type: 'cascadeDepth',       depth: 4 } },
  // Hand-laid boards (verified by tests: no pre-match, ≥1 valid move, and the
  // designed solution achieves the goal).
  {
    id: 13, nameKey: 'puzzle.13.name', hintKey: 'puzzle.13.hint', moves: 6,
    goal: { type: 'createSpecial', special: SPECIAL.AREA_BOMB, count: 1 },
    board: ['01230123', '23052301', '01250123', '23515301', '01250123', '23012301', '01230123', '23012301'],
  },
  {
    id: 14, nameKey: 'puzzle.14.name', hintKey: 'puzzle.14.hint', moves: 8,
    goal: { type: 'createSpecial', special: SPECIAL.LINE_H, count: 2 },
    board: ['01230123', '23012301', '06636123', '23062301', '01234123', '23442401', '01230123', '23012301'],
  },
  {
    id: 15, nameKey: 'puzzle.15.name', hintKey: 'puzzle.15.hint', moves: 1,
    goal: { type: 'cascadeDepth', depth: 2 },
    board: ['01230123', '23012301', '01230123', '23612301', '01530123', '23512301', '06460123', '23512301'],
  },
];

export function getPuzzle(id) {
  return PUZZLES.find(p => p.id === id);
}

// Returns true if `progress` (built by the scene) satisfies the puzzle's goal.
export function isGoalMet(goal, progress) {
  switch (goal.type) {
    case 'totalScore':       return progress.score >= goal.amount;
    case 'clearGemsOfColor': return (progress.clearedByColor[goal.color] || 0) >= goal.count;
    case 'createSpecial':    return countSpecial(progress, goal.special) >= goal.count;
    case 'cascadeDepth':     return progress.maxCascadeDepth >= goal.depth;
    default: return false;
  }
}

// LINE_H and LINE_V are visually identical to the player ("Line Gem") and are
// determined by match orientation, which is incidental. Count them together so
// a goal of "make N line gems" credits either direction.
function countSpecial(progress, special) {
  if (special === SPECIAL.LINE_H || special === SPECIAL.LINE_V) {
    return (progress.specialsCreated[SPECIAL.LINE_H] || 0)
         + (progress.specialsCreated[SPECIAL.LINE_V] || 0);
  }
  return progress.specialsCreated[special] || 0;
}

// Human-readable progress text for the HUD. Strings come from i18n via the
// per-goal-type template keys.
import * as i18n from './i18n.js';

const SPECIAL_KEYS = {
  [SPECIAL.LINE_H]:     'special.lineGem',
  [SPECIAL.LINE_V]:     'special.lineGem',
  [SPECIAL.COLOR_BOMB]: 'special.colorBomb',
  [SPECIAL.AREA_BOMB]:  'special.areaBomb',
  [SPECIAL.STAR]:       'special.star',
};

export function goalText(goal) {
  switch (goal.type) {
    case 'totalScore':
      return i18n.t('puzzle.goal.totalScore', { amount: i18n.formatNumber(goal.amount) });
    case 'clearGemsOfColor':
      return i18n.t('puzzle.goal.clearGemsOfColor', { count: goal.count, color: i18n.t(`color.${goal.color}`) });
    case 'createSpecial':
      return i18n.t('puzzle.goal.createSpecial', {
        count: goal.count,
        special: i18n.t(SPECIAL_KEYS[goal.special] || 'special.generic'),
      });
    case 'cascadeDepth':
      return i18n.t('puzzle.goal.cascadeDepth', { depth: goal.depth });
    default: return '???';
  }
}

export function progressText(goal, progress) {
  switch (goal.type) {
    case 'totalScore':
      return i18n.t('puzzle.progress.totalScore', {
        score: i18n.formatNumber(progress.score),
        amount: i18n.formatNumber(goal.amount),
      });
    case 'clearGemsOfColor':
      return i18n.t('puzzle.progress.clearGemsOfColor', {
        cleared: progress.clearedByColor[goal.color] || 0,
        count: goal.count,
      });
    case 'createSpecial':
      return i18n.t('puzzle.progress.createSpecial', {
        cleared: countSpecial(progress, goal.special),
        count: goal.count,
      });
    case 'cascadeDepth':
      return i18n.t('puzzle.progress.cascadeDepth', {
        best: progress.maxCascadeDepth || 0,
        depth: goal.depth,
      });
    default: return '';
  }
}
