// Lightweight i18n: English + Spanish, runtime locale switching, no build step.
//
// Independent module — depends only on storage. Imported by main.js at boot and
// then by every scene that draws text. No reverse dependency on render/main so
// circular imports stay impossible.
//
// Translation strategy:
//   - `t(key, vars)` looks up a key in the active locale; falls back to `en`
//     then to the key string itself so missed keys are visible during testing.
//   - Vars interpolate `{name}` → vars.name. Missing vars are left untouched.
//   - `tn(key, count, vars)` picks `key.one` for count===1, else `key.other`,
//     and injects `{n}` automatically (callers can override via vars).
//   - `formatNumber` / `formatDate` route through `Intl.*` against the active
//     locale so a player who picks "English" gets `1,234` on a Spanish device.
//
// Locale resolution (see resolveLocale()):
//   1. saved settings.language ('auto' | 'en' | 'es')
//   2. when 'auto':
//        a. ?lang=en|es URL override (localhost only)
//        b. navigator.languages startsWith 'es' → 'es'
//        c. fallback: 'en'

import * as storage from './storage.js';

// ----- Dictionaries -----

const en = {
  // Common, reused everywhere
  'common.back':       'Back',
  'common.backShort':  '←',
  'common.close':      'Close',
  'common.ok':         'OK',
  'common.cancel':     'Cancel',
  'common.start':      'Start',
  'common.retry':      '↻ Retry',
  'common.again':      '↻ Again',
  'common.title':      '🏠 Title',
  'common.share':      '📤 Share',
  'common.next':       '▶ Next',
  'common.nextLevel':  '▶ Next Level',
  'common.nextPuzzle': '▶ Next puzzle',
  'common.allPuzzles': '📋 All puzzles',
  'common.copiedToClipboard': 'Copied to clipboard!',

  // Title scene
  'title.brand':           'JEWELED',
  'title.welcomeBack':     'Welcome back, {name}',
  'title.continueZen':     '▶ Continue Zen',
  'title.continueClassic': '▶ Continue Classic',
  'title.continueSubtitleClassic': 'L{level} · {score}',
  'title.continueSubtitleZen':     '{score} pts',
  'title.streak':          'streak',
  'title.zen':             '🧘  Zen',
  'title.classic':         '🎯  Classic',
  'title.daily':           '📅  Daily',
  'title.blitz':           '⚡  Blitz',
  'title.puzzles':         '🧩  Puzzles',
  'title.zenBest':         'Best: {score}',
  'title.zenEndless':      'Endless · always solvable',
  'title.classicSubtitle': 'Level {current} / {total}  ·  ★ {stars}',
  'title.dailySubtitle':   '{date}',
  'title.dailySubtitleDone': '{date} ✓',
  'title.blitzSubtitleBest': '60 active sec  ·  Best: {score}',
  'title.blitzSubtitle':   '60 active sec',
  'title.puzzlesSubtitle': '{done} / {total} solved',
  'title.stats':           '📊  Stats',
  'title.settings':        '⚙  Settings',

  // Settings overlay
  'settings.title':           'Settings',
  'settings.haptic':          'Haptic feedback',
  'settings.paintingMode':    'Painting Zen mode',
  'settings.language':        'Language',
  'settings.languageAuto':    'Auto',
  'settings.languageEn':      'English',
  'settings.languageEs':      'Español',
  'settings.resetProgress':   '🗑 Reset progress',
  'settings.resetConfirm':    'Wipe all progress and player name?',
  'settings.close':           'Close',

  // Name-entry modal (DOM)
  'name_entry.label':         'Choose your name',
  'name_entry.start':         'Start',

  // Zen HUD
  'zen.title':                '🧘 Zen',
  'zen.end':                  'End',
  'zen.endShort':             'End',
  'zen.savePaintingConfirm':  'Save your painting from this Zen session?',

  // Classic HUD
  'classic.level':            'Level {n}',
  'classic.moves':            'Moves: {n}',

  // Daily HUD
  'daily.title':              '📅 Daily',
  'daily.movesLeft':          'Moves left: {n}',
  'daily.replayDoesNotCount': 'Replay (does not count)',
  'daily.todayLabel':         '{date}',

  // Blitz HUD
  'blitz.title':              '⚡ Blitz',
  'blitz.seconds':            '{n}s',

  // Result scene
  'result.classicWin':           'Level Complete!',
  'result.classicLose':          'Out of Moves',
  'result.classicSubtitleWin':   '{score} pts  (target {target})',
  'result.classicSubtitleLose':  '{score} / {target}',
  'result.dailyHeader':          'Daily — {date}',
  'result.newBest':              '🏆 New best!',
  'result.bestEver':             'Best ever: {score}',
  'result.blitzDone':            '⚡ Blitz Done',
  'result.best':                 'Best: {score}',
  'result.puzzleWin':            '🧩 Solved!',
  'result.puzzleLose':           'Puzzle Failed',
  'result.goalNotReached':       'Goal not reached',
  'result.runEnded':             'Run Ended',
  'result.scorePts':             '{score} pts',
  'result.shareDailyText':       'Jeweled Daily {date}: {score} pts',

  // Level select
  'levelSelect.title':           'Classic — Choose a Level',
  'levelSelect.page':            'Page {page} / {total}',

  // Puzzle select
  'puzzleSelect.title':          '🧩 Puzzles',
  'puzzleSelect.solvedCount':    '{done} / {total} solved',
  'puzzleSelect.tileMoves':      { one: '{n} move', other: '{n} moves' },
  'puzzleSelect.tileLabel':      '#{id}  {name}',

  // Puzzle HUD
  'puzzle.title':                '🧩 {name}',
  'puzzle.moves':                'Moves: {n}',

  // Puzzle goals / progress
  'puzzle.goal.totalScore':       'Score {amount}',
  'puzzle.goal.clearGemsOfColor': 'Clear {count} {color} gems',
  'puzzle.goal.createSpecial':    'Make {count} {special}',
  'puzzle.goal.cascadeDepth':     'Trigger a {depth}-chain cascade',
  'puzzle.progress.totalScore':       '{score} / {amount}',
  'puzzle.progress.clearGemsOfColor': '{cleared} / {count}',
  'puzzle.progress.createSpecial':    '{cleared} / {count}',
  'puzzle.progress.cascadeDepth':     'Best chain: {best} / {depth}',

  // Puzzle names + hints (per ID)
  'puzzle.1.name':  'First Steps',       'puzzle.1.hint':  'Just match three. You got this.',
  'puzzle.2.name':  'Red Hunt',          'puzzle.2.hint':  'Clear 10 red gems.',
  'puzzle.3.name':  'Blue Sweep',        'puzzle.3.hint':  'Clear 12 blue gems.',
  'puzzle.4.name':  'Line It Up',        'puzzle.4.hint':  'Match 4 in a row, twice.',
  'puzzle.5.name':  'Chain Reaction',    'puzzle.5.hint':  'Trigger a 2-cascade chain.',
  'puzzle.6.name':  'Score Sprint',      'puzzle.6.hint':  'Hit 1,500 in 10 moves.',
  'puzzle.7.name':  'Boom!',             'puzzle.7.hint':  'Make a T or L shape.',
  'puzzle.8.name':  'Rainbow Rush',      'puzzle.8.hint':  'Clear 15 purple gems.',
  'puzzle.9.name':  'Color Bomb',        'puzzle.9.hint':  'Match 5 in a row.',
  'puzzle.10.name': 'Deep Chain',        'puzzle.10.hint': 'Trigger a 3-cascade chain.',
  'puzzle.11.name': 'Marathon',          'puzzle.11.hint': 'Pace yourself.',
  'puzzle.12.name': 'Star Maker',        'puzzle.12.hint': 'A 4-chain spawns a Star.',

  // Colors + specials (used by puzzle goal/progress strings)
  'color.0': 'red',    'color.1': 'blue',    'color.2': 'green',
  'color.3': 'yellow', 'color.4': 'purple',  'color.5': 'white',  'color.6': 'black',
  'special.lineGem':    'Line Gem',
  'special.colorBomb':  'Color Bomb',
  'special.areaBomb':   'Area Bomb',
  'special.star':       'Star',
  'special.generic':    'special',

  // Stats scene
  'stats.title':                  'Stats & Achievements',
  'stats.unlockedSummary':        '{unlocked} / {total} unlocked',
  'stats.totalGemsCleared':       'Total gems cleared',
  'stats.zenBestScore':           'Zen best score',
  'stats.zenRunsPlayed':          'Zen runs played',
  'stats.classicLevelsBeaten':    'Classic levels beaten',
  'stats.classicLevelsBeatenValue': '{n} / 300',
  'stats.dailyChallengesCompleted':'Daily challenges completed',
  'stats.blitzBestScore':         'Blitz best score',

  // Powerup overlay
  'powerup.shuffle.label':     'Shuffle',
  'powerup.colorBlast.label':  'Color Blast',
  'powerup.bombDrop.label':    'Bomb Drop',
  'powerup.recolor.label':     'Recolor',
  'powerup.targetHint':        '{emoji}  {label} — tap a gem',
  'powerup.tapOutsideCancel':  '(tap outside the board to cancel)',
  'powerup.pickColor':         'Pick a color',
  'powerup.chargeEarned':      '+1 charge earned!',
  'powerup.pickFill':          'Pick which power-up to fill',
  'powerup.saveForLater':      'Or save for later (tap outside)',

  // Achievement toast
  'achievement.unlocked': 'ACHIEVEMENT UNLOCKED',

  // Achievements (per ID — see src/achievements.js)
  'achievement.first_match.name':    'First Match',    'achievement.first_match.desc':    'Make your first match.',
  'achievement.matches_100.name':    'Combo Maker',    'achievement.matches_100.desc':    'Clear 100 gems total.',
  'achievement.matches_1000.name':   'Match Master',   'achievement.matches_1000.desc':   'Clear 1,000 gems total.',
  'achievement.matches_10000.name':  'Cascade Lord',   'achievement.matches_10000.desc':  'Clear 10,000 gems total.',
  'achievement.cascade_3.name':      'On Fire',        'achievement.cascade_3.desc':      'Trigger a 3-cascade chain.',
  'achievement.cascade_5.name':      'Star Born',      'achievement.cascade_5.desc':      'Trigger a 5-cascade chain.',
  'achievement.cascade_8.name':      'Unstoppable',    'achievement.cascade_8.desc':      'Trigger an 8-cascade chain.',
  'achievement.special_color.name':  'Color Bomb',     'achievement.special_color.desc':  'Spawn your first Color Bomb.',
  'achievement.special_area.name':   'Big Boom',       'achievement.special_area.desc':   'Spawn your first Area Bomb.',
  'achievement.special_star.name':   'Constellation',  'achievement.special_star.desc':   'Spawn your first Star.',
  'achievement.classic_l10.name':    'Apprentice',     'achievement.classic_l10.desc':    'Beat Classic Level 10.',
  'achievement.classic_l50.name':    'Expert',         'achievement.classic_l50.desc':    'Beat Classic Level 50.',
  'achievement.classic_l100.name':   'Master',         'achievement.classic_l100.desc':   'Beat Classic Level 100.',
  'achievement.classic_l200.name':   'Grandmaster',    'achievement.classic_l200.desc':   'Beat Classic Level 200.',
  'achievement.first_zen.name':      'Inner Peace',    'achievement.first_zen.desc':      'Play your first Zen run.',
  'achievement.first_daily.name':    'Daily Habit',    'achievement.first_daily.desc':    'Complete your first Daily challenge.',
  'achievement.first_blitz.name':    'Speed Demon',    'achievement.first_blitz.desc':    'Complete your first Blitz run.',
  'achievement.first_puzzle.name':   'Puzzler',        'achievement.first_puzzle.desc':   'Solve your first Puzzle.',
  'achievement.score_zen_10k.name':  'Zen 10k',        'achievement.score_zen_10k.desc':  'Score 10,000 in a single Zen run.',
  'achievement.score_zen_100k.name': 'Zen 100k',       'achievement.score_zen_100k.desc': 'Score 100,000 in a single Zen run.',
};

const es = {
  // Common
  'common.back':       'Volver',
  'common.backShort':  '←',
  'common.close':      'Cerrar',
  'common.ok':         'Aceptar',
  'common.cancel':     'Cancelar',
  'common.start':      'Comenzar',
  'common.retry':      '↻ Reintentar',
  'common.again':      '↻ Otra vez',
  'common.title':      '🏠 Inicio',
  'common.share':      '📤 Compartir',
  'common.next':       '▶ Siguiente',
  'common.nextLevel':  '▶ Siguiente nivel',
  'common.nextPuzzle': '▶ Siguiente puzzle',
  'common.allPuzzles': '📋 Todos los puzzles',
  'common.copiedToClipboard': '¡Copiado al portapapeles!',

  // Title scene
  // 'title.brand' intentionally NOT translated — brand chip stays English.
  'title.welcomeBack':     'Hola de nuevo, {name}',
  'title.continueZen':     '▶ Continuar Zen',
  'title.continueClassic': '▶ Continuar Clásico',
  'title.continueSubtitleClassic': 'L{level} · {score}',
  'title.continueSubtitleZen':     '{score} pts',
  'title.streak':          'racha',
  // Mode chips stay branded English by design.
  'title.zenBest':         'Mejor: {score}',
  'title.zenEndless':      'Infinito · siempre resoluble',
  'title.classicSubtitle': 'Nivel {current} / {total}  ·  ★ {stars}',
  'title.dailySubtitle':   '{date}',
  'title.dailySubtitleDone': '{date} ✓',
  'title.blitzSubtitleBest': '60s activos  ·  Mejor: {score}',
  'title.blitzSubtitle':   '60s activos',
  'title.puzzlesSubtitle': '{done} / {total} resueltos',
  'title.stats':           '📊  Estadísticas',
  'title.settings':        '⚙  Ajustes',

  // Settings
  'settings.title':           'Ajustes',
  'settings.haptic':          'Vibración',
  'settings.paintingMode':    'Modo pintura Zen',
  'settings.language':        'Idioma',
  'settings.languageAuto':    'Auto',
  'settings.languageEn':      'English',
  'settings.languageEs':      'Español',
  'settings.resetProgress':   '🗑 Borrar progreso',
  'settings.resetConfirm':    '¿Borrar todo el progreso y el nombre del jugador?',
  'settings.close':           'Cerrar',

  // Name-entry modal
  'name_entry.label':         'Elige tu nombre',
  'name_entry.start':         'Comenzar',

  // Zen HUD
  'zen.end':                  'Salir',
  'zen.endShort':             'Salir',
  'zen.savePaintingConfirm':  '¿Guardar la pintura de esta sesión Zen?',

  // Classic HUD
  'classic.level':            'Nivel {n}',
  'classic.moves':            'Movimientos: {n}',

  // Daily HUD
  'daily.movesLeft':          'Movimientos: {n}',
  'daily.replayDoesNotCount': 'Repetición (no cuenta)',

  // Blitz HUD (no key overrides — uses English 'Xs' format)
  'blitz.seconds':            '{n}s',

  // Result scene
  'result.classicWin':           '¡Nivel completado!',
  'result.classicLose':          'Sin movimientos',
  'result.classicSubtitleWin':   '{score} pts  (objetivo {target})',
  'result.classicSubtitleLose':  '{score} / {target}',
  'result.dailyHeader':          'Diario — {date}',
  'result.newBest':              '🏆 ¡Nuevo récord!',
  'result.bestEver':             'Mejor histórico: {score}',
  'result.blitzDone':            '⚡ Blitz terminado',
  'result.best':                 'Mejor: {score}',
  'result.puzzleWin':            '🧩 ¡Resuelto!',
  'result.puzzleLose':           'Puzzle fallido',
  'result.goalNotReached':       'Objetivo no alcanzado',
  'result.runEnded':             'Partida terminada',
  'result.scorePts':             '{score} pts',
  'result.shareDailyText':       'Jeweled Diario {date}: {score} pts',

  // Level select
  'levelSelect.title':           'Clásico — Elige nivel',
  'levelSelect.page':            'Página {page} / {total}',

  // Puzzle select
  'puzzleSelect.title':          '🧩 Puzzles',
  'puzzleSelect.solvedCount':    '{done} / {total} resueltos',
  'puzzleSelect.tileMoves':      { one: '{n} movimiento', other: '{n} movimientos' },
  'puzzleSelect.tileLabel':      '#{id}  {name}',

  // Puzzle HUD
  'puzzle.title':                '🧩 {name}',
  'puzzle.moves':                'Movimientos: {n}',

  // Puzzle goals / progress
  'puzzle.goal.totalScore':       'Anota {amount}',
  'puzzle.goal.clearGemsOfColor': 'Despeja {count} gemas {color}',
  'puzzle.goal.createSpecial':    'Crea {count} {special}',
  'puzzle.goal.cascadeDepth':     'Encadena una cascada de {depth}',
  'puzzle.progress.totalScore':       '{score} / {amount}',
  'puzzle.progress.clearGemsOfColor': '{cleared} / {count}',
  'puzzle.progress.createSpecial':    '{cleared} / {count}',
  'puzzle.progress.cascadeDepth':     'Mejor cadena: {best} / {depth}',

  // Puzzle names + hints
  'puzzle.1.name':  'Primeros Pasos',     'puzzle.1.hint':  'Haz una combinación de tres. Tú puedes.',
  'puzzle.2.name':  'Cacería Roja',       'puzzle.2.hint':  'Despeja 10 gemas rojas.',
  'puzzle.3.name':  'Barrido Azul',       'puzzle.3.hint':  'Despeja 12 gemas azules.',
  'puzzle.4.name':  'En Línea',           'puzzle.4.hint':  'Combina 4 en fila, dos veces.',
  'puzzle.5.name':  'Reacción en Cadena', 'puzzle.5.hint':  'Encadena una cascada de 2.',
  'puzzle.6.name':  'Sprint de Puntos',   'puzzle.6.hint':  'Llega a 1.500 en 10 movimientos.',
  'puzzle.7.name':  '¡Boom!',             'puzzle.7.hint':  'Forma una T o una L.',
  'puzzle.8.name':  'Lluvia Arcoíris',    'puzzle.8.hint':  'Despeja 15 gemas púrpuras.',
  'puzzle.9.name':  'Bomba de Color',     'puzzle.9.hint':  'Combina 5 en fila.',
  'puzzle.10.name': 'Cadena Profunda',    'puzzle.10.hint': 'Encadena una cascada de 3.',
  'puzzle.11.name': 'Maratón',            'puzzle.11.hint': 'A tu ritmo.',
  'puzzle.12.name': 'Creador de Estrellas','puzzle.12.hint': 'Una cadena de 4 crea una Estrella.',

  // Colors + specials
  'color.0': 'rojas',    'color.1': 'azules',   'color.2': 'verdes',
  'color.3': 'amarillas','color.4': 'púrpuras', 'color.5': 'blancas',  'color.6': 'negras',
  'special.lineGem':    'Gema Línea',
  'special.colorBomb':  'Bomba de Color',
  'special.areaBomb':   'Bomba de Área',
  'special.star':       'Estrella',
  'special.generic':    'especial',

  // Stats
  'stats.title':                  'Estadísticas y Logros',
  'stats.unlockedSummary':        '{unlocked} / {total} desbloqueados',
  'stats.totalGemsCleared':       'Gemas despejadas',
  'stats.zenBestScore':           'Mejor puntuación Zen',
  'stats.zenRunsPlayed':          'Partidas Zen jugadas',
  'stats.classicLevelsBeaten':    'Niveles Clásico superados',
  'stats.classicLevelsBeatenValue': '{n} / 300',
  'stats.dailyChallengesCompleted':'Diarios completados',
  'stats.blitzBestScore':         'Mejor puntuación Blitz',

  // Powerup overlay
  'powerup.shuffle.label':     'Mezclar',
  'powerup.colorBlast.label':  'Estallido de Color',
  'powerup.bombDrop.label':    'Lanzar Bomba',
  'powerup.recolor.label':     'Recolorear',
  'powerup.targetHint':        '{emoji}  {label} — toca una gema',
  'powerup.tapOutsideCancel':  '(toca fuera del tablero para cancelar)',
  'powerup.pickColor':         'Elige un color',
  'powerup.chargeEarned':      '¡+1 carga obtenida!',
  'powerup.pickFill':          'Elige qué potenciador rellenar',
  'powerup.saveForLater':      'O guarda para luego (toca fuera)',

  // Achievement toast
  'achievement.unlocked': 'LOGRO DESBLOQUEADO',

  // Achievements
  'achievement.first_match.name':    'Primera Combinación', 'achievement.first_match.desc':    'Haz tu primera combinación.',
  'achievement.matches_100.name':    'Combinador',          'achievement.matches_100.desc':    'Despeja 100 gemas en total.',
  'achievement.matches_1000.name':   'Maestro Combinador',  'achievement.matches_1000.desc':   'Despeja 1.000 gemas en total.',
  'achievement.matches_10000.name':  'Señor de la Cascada', 'achievement.matches_10000.desc':  'Despeja 10.000 gemas en total.',
  'achievement.cascade_3.name':      'En Llamas',           'achievement.cascade_3.desc':      'Encadena una cascada de 3.',
  'achievement.cascade_5.name':      'Nacida una Estrella', 'achievement.cascade_5.desc':      'Encadena una cascada de 5.',
  'achievement.cascade_8.name':      'Imparable',           'achievement.cascade_8.desc':      'Encadena una cascada de 8.',
  'achievement.special_color.name':  'Bomba de Color',      'achievement.special_color.desc':  'Crea tu primera Bomba de Color.',
  'achievement.special_area.name':   'Gran Estallido',      'achievement.special_area.desc':   'Crea tu primera Bomba de Área.',
  'achievement.special_star.name':   'Constelación',        'achievement.special_star.desc':   'Crea tu primera Estrella.',
  'achievement.classic_l10.name':    'Aprendiz',            'achievement.classic_l10.desc':    'Supera el Nivel 10 de Clásico.',
  'achievement.classic_l50.name':    'Experto',             'achievement.classic_l50.desc':    'Supera el Nivel 50 de Clásico.',
  'achievement.classic_l100.name':   'Maestro',             'achievement.classic_l100.desc':   'Supera el Nivel 100 de Clásico.',
  'achievement.classic_l200.name':   'Gran Maestro',        'achievement.classic_l200.desc':   'Supera el Nivel 200 de Clásico.',
  'achievement.first_zen.name':      'Paz Interior',        'achievement.first_zen.desc':      'Juega tu primera partida Zen.',
  'achievement.first_daily.name':    'Hábito Diario',       'achievement.first_daily.desc':    'Completa tu primer Diario.',
  'achievement.first_blitz.name':    'Velocista',           'achievement.first_blitz.desc':    'Completa tu primer Blitz.',
  'achievement.first_puzzle.name':   'Resolvedor',          'achievement.first_puzzle.desc':   'Resuelve tu primer Puzzle.',
  'achievement.score_zen_10k.name':  'Zen 10k',             'achievement.score_zen_10k.desc':  'Anota 10.000 en una sola partida Zen.',
  'achievement.score_zen_100k.name': 'Zen 100k',            'achievement.score_zen_100k.desc': 'Anota 100.000 en una sola partida Zen.',
};

const DICTIONARIES = { en, es };

// ----- State -----

let _setting = 'auto';   // raw value from storage: 'auto' | 'en' | 'es'
let _locale = 'en';      // resolved locale: 'en' | 'es'

// Cached Intl instances per locale; rebuilt on locale change so we don't
// allocate a fresh formatter for every formatNumber call.
let _nfCache = null;
let _dfCache = null;

// ----- Public API -----

export function init() {
  _setting = (storage.getSettings().language) || 'auto';
  _locale = resolveLocale(_setting);
  _nfCache = new Intl.NumberFormat(_locale);
  _dfCache = new Intl.DateTimeFormat(_locale, { year: 'numeric', month: 'short', day: 'numeric' });
  syncDocumentLang();
}

export function setLanguage(value) {
  if (value !== 'auto' && value !== 'en' && value !== 'es') return;
  _setting = value;
  storage.saveKey('settings', { language: value });
  const newLocale = resolveLocale(_setting);
  if (newLocale === _locale) return;
  _locale = newLocale;
  _nfCache = new Intl.NumberFormat(_locale);
  _dfCache = new Intl.DateTimeFormat(_locale, { year: 'numeric', month: 'short', day: 'numeric' });
  // Locale changed → template strings differ → cached interpolations are stale.
  _interpolateCache.clear();
  syncDocumentLang();
}

// Keep <html lang> in sync with the active locale so screen readers pick the
// right pronunciation voice (matters when the player switches to Spanish on
// a device whose default is English, or vice versa).
function syncDocumentLang() {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = _locale;
  }
}

export function getLanguageSetting() { return _setting; }
export function getLocale() { return _locale; }

// Translate. Vars interpolate {name} → vars.name. Falls back to en, then to
// the key itself so missed strings are visible during testing.
export function t(key, vars) {
  if (key == null) {
    warnDev('i18n.t() called with empty key');
    return '';
  }
  const v = lookup(key, _locale) ?? lookup(key, 'en');
  if (v == null) return key;
  return vars ? interpolate(v, vars) : v;
}

// Pluralized translate. Looks up `key.one` or `key.other` depending on count.
// Automatically injects {n} = count; callers can override via vars.
export function tn(key, count, vars) {
  if (key == null) {
    warnDev('i18n.tn() called with empty key');
    return '';
  }
  const entry = lookupRaw(key, _locale) ?? lookupRaw(key, 'en');
  if (entry == null || typeof entry !== 'object') return t(key, { ...(vars || {}), n: count });
  const tmpl = (count === 1 ? entry.one : entry.other) || entry.other || entry.one || key;
  return interpolate(tmpl, { ...(vars || {}), n: count });
}

export function formatNumber(n) {
  return _nfCache ? _nfCache.format(n) : String(n);
}

export function formatDate(date, opts) {
  const normalized = normalizeDateInput(date);
  if (!(normalized instanceof Date) || Number.isNaN(normalized.getTime())) return String(date ?? '');
  if (!_dfCache) return String(date);
  if (opts) return new Intl.DateTimeFormat(_locale, opts).format(normalized);
  return _dfCache.format(normalized);
}

// ----- Internals -----

function resolveLocale(setting) {
  if (setting === 'en' || setting === 'es') return setting;
  // 'auto' (or anything unexpected) — debug URL override on localhost, then
  // navigator.languages, then English.
  if (typeof location !== 'undefined' &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'es') return q;
  }
  const langs = (typeof navigator !== 'undefined' && navigator.languages) || [];
  for (const l of langs) {
    if (l && l.toLowerCase().startsWith('es')) return 'es';
    if (l && l.toLowerCase().startsWith('en')) return 'en';
  }
  return 'en';
}

function lookupRaw(key, locale) {
  const dict = DICTIONARIES[locale];
  return dict ? dict[key] : undefined;
}

function lookup(key, locale) {
  const raw = lookupRaw(key, locale);
  if (raw == null) return undefined;
  // For plain string entries we return as-is. For {one, other} entries the
  // caller should be using tn(); but if someone calls t() on a plural entry,
  // return the `other` form as a safe fallback.
  if (typeof raw === 'object') return raw.other ?? raw.one;
  return raw;
}

// HUD strings like 'Level {n}' / 'Moves: {n}' are interpolated every frame with
// values that are stable for seconds. Memoize so the regex replace + String()
// allocation only happens when (template, vars) actually changes.
//
// Caller contract: every existing call site passes vars whose values are
// primitives (numbers, strings, booleans), so `'|' + k + '=' + vars[k]` produces
// a unique key. for...in iterates string keys in insertion order per ES spec.
const _interpolateCache = new Map();
function interpolate(template, vars) {
  let key = template;
  for (const k in vars) key += '|' + k + '=' + vars[k];
  const cached = _interpolateCache.get(key);
  if (cached !== undefined) return cached;
  if (_interpolateCache.size > 256) _interpolateCache.clear();
  const out = template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  _interpolateCache.set(key, out);
  return out;
}

function normalizeDateInput(date) {
  if (date instanceof Date) return date;
  if (typeof date === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(date);
}

function warnDev(message) {
  if (typeof location !== 'undefined' &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    console.warn(message);
  }
}
