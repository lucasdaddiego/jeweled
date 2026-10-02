// Guard for a fresh run that would replace a parked one.
//
// Zen and Classic each keep one resumable snapshot (storage <mode>.saveState),
// and a fresh run overwrites it on its first idle snapshot. The title's
// Continue button offers only the newest parked run, so the other one is
// invisible from there: starting that mode used to drop it without a word.

import * as storage from './storage.js';
import * as dialogs from './dialogs.js';
import * as i18n from './i18n.js';

// Run `start` at once when `mode` has nothing parked. Otherwise ask first, in
// the in-canvas dialog; on OK drop the parked run (the dialog said it would be
// lost) and start, on Cancel do nothing. The no-save path stays synchronous so
// a scene swap still happens inside the tap that asked for it.
export function startNewRun(mode, start) {
  const parked = storage.load()[mode].saveState;
  if (!parked) { start(); return; }
  const score = i18n.formatNumber(parked.score || 0);   // imported saves may lack it
  const message = mode === 'classic'
    ? i18n.t('parked.discardClassic', { level: parked.level, score })
    : i18n.t('parked.discardZen', { score });
  dialogs.confirm(message, { confirmLabel: i18n.t('parked.newRun') }).then((ok) => {
    if (!ok) return;
    storage.saveKey(mode, { saveState: null });
    start();
  });
}
