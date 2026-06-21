// Wake Lock helper — prevents the screen from dimming during long game sessions.
//
// Browsers automatically release `screen` wake locks when the document is
// hidden. We track an explicit "wanted" flag so we can re-acquire on
// visibilitychange and survive tab-switches mid-session.

// Single-owner model: at most one game scene is active at a time, so the
// single `wanted` flag is sufficient. If we ever stack overlay scenes that
// independently want the lock (e.g. a preview pane over a game scene), this
// will need to become a reference count to avoid one scene's `release()`
// dropping the lock that the other scene still wants.
let lock = null;
let wanted = false;

async function tryRequest() {
  if (lock || typeof navigator === 'undefined' || !navigator.wakeLock) return;
  try {
    const l = await navigator.wakeLock.request('screen');
    // request() is async: by the time it resolves the caller may have already
    // release()d (wanted=false) or the page may have hidden. release() is
    // synchronous and only acts on an assigned `lock`, so without this re-check
    // the just-acquired lock would be orphaned — the screen stays awake on the
    // menu, draining battery, until the next hide or clean game exit.
    if (!wanted || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) {
      try { l.release(); } catch { /* ignore */ }
      return;
    }
    lock = l;
    lock.addEventListener('release', () => {
      lock = null;
      if (wanted && typeof document !== 'undefined' && document.visibilityState === 'visible') {
        tryRequest();
      }
    }, { once: true });
  }
  catch { /* user denied, unsupported, or page hidden — ignore */ }
}

export async function acquire() {
  wanted = true;
  await tryRequest();
}

export function release() {
  wanted = false;
  if (lock) {
    try { lock.release(); } catch { /* ignore */ }
    lock = null;
  }
}

// Re-acquire when the page comes back to the foreground. The browser releases
// our lock on hide; without this, long Zen sessions dim the screen after a
// single tab-switch.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible' && !lock) {
      tryRequest();
    }
  });
  // Desktop: alt-tab / window blur can release the lock while visibilityState
  // stays 'visible', so visibilitychange never fires on return. Re-acquire on
  // window focus too. (Mobile relies on visibilitychange above.)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      if (wanted && document.visibilityState === 'visible' && !lock) {
        tryRequest();
      }
    });
  }
}
