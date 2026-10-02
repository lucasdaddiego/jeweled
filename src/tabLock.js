// One active tab.
//
// Every tab of the game shares one localStorage save, and each tab keeps its
// own copy in memory (storage.js `cache`) that it writes back whole. A second
// tab used to write its stale copy over the newer progress of the first tab.
// Now only the tab that holds a Web Lock writes. Any other tab shows "open in
// another tab" in the in-canvas dialog and drops its writes (storage write
// gate).
//
// Why a Web Lock and not a heartbeat in localStorage: the browser releases a
// Web Lock when its tab closes or crashes, so a blocked tab can take over
// without guessing. A heartbeat cannot tell a crashed tab from a background
// tab whose timers the browser throttles to one run a minute. A BroadcastChannel
// carries the messages a lock cannot: "Play here" asks a live owner to save and
// step aside before the new tab takes the lock, and "bye" tells blocked tabs
// that the owner is reloading.
//
// Lifecycle:
//   start()     boot: hold writes, ask for the lock (retried for a short grace,
//               because after a reload the old page can still hold it), then
//               own the save or block.
//   blocked     poll the lock: the owner closed or crashed -> take over.
//   Play here   ask the owner to yield, then steal the lock.
//   release()   pagehide: give the lock back after the last write.
//   reacquire() pageshow from the back/forward cache: ask again.
//
// No lock is used (state 'solo', writes as before) when site data is blocked
// (storage writes nothing anyway), or when the browser has no Web Locks.

import * as storage from './storage.js';
import * as dialogs from './dialogs.js';
import * as i18n from './i18n.js';

const LOCK_NAME = 'gem-match:tab';
const CHANNEL_NAME = 'gem-match:tab';
export const BOOT_RETRY_MS = 250;
export const BOOT_GRACE_MS = 1500;
export const POLL_MS = 2000;
// After an owner says "bye", a blocked tab waits this long before it takes the
// lock, so a reloading owner gets its lock back first.
export const BYE_GRACE_MS = 2000;
export const YIELD_WAIT_MS = 1000;

let state = 'solo';        // 'solo' | 'pending' | 'owner' | 'blocked'
let onTakeover = null;     // main.js: (adopt) => void
let releaseHeld = null;    // resolves the promise that holds the lock
let channel = null;
let pollTimer = null;
let busy = false;          // a poll or a Play here request is in flight
let showing = false;       // the blocked-dialog loop runs
let awaitingYield = null;  // ends the Play here wait on 'yielded'
let lastByeAt = -Infinity;
let generation = 0;        // bumps on release(): a stale boot loop stops

export function getState() { return state; }

export function start(opts = {}) {
  onTakeover = opts.onTakeover || null;
  if (!storage.isAvailable()) return;
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return;
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = onMessage;
  }
  acquireAtBoot();
}

// pagehide: the page goes away (or into the back/forward cache). Call it after
// the last flush. Later writes wait for reacquire().
export function release() {
  if (state !== 'owner' && state !== 'pending') return;
  const wasOwner = state === 'owner';
  generation++;
  state = 'pending';
  storage.setWriteGate('held');
  if (!wasOwner) return;
  dropLock();
  post({ t: 'bye' });
}

// pageshow with event.persisted: the page came back from the cache.
export function reacquire() {
  if (state === 'pending') acquireAtBoot();
}

async function acquireAtBoot() {
  const gen = ++generation;
  state = 'pending';
  storage.setWriteGate('held');
  const deadline = Date.now() + BOOT_GRACE_MS;
  for (;;) {
    const got = await tryAcquire(false);
    if (gen !== generation) {   // the page left while the request was out
      if (got) dropLock();
      return;
    }
    if (got === null) { goSolo(); return; }
    if (got) { becomeOwner(); return; }
    if (Date.now() >= deadline) break;
    await sleep(BOOT_RETRY_MS);
    if (gen !== generation) return;
  }
  becomeBlocked();
}

// Resolves true when this tab now holds the lock, false when another tab holds
// it, and null when the browser refuses the Locks API.
function tryAcquire(steal) {
  return new Promise((resolve) => {
    let granted = false;
    const opts = steal ? { steal: true } : { ifAvailable: true };
    let req;
    try {
      req = navigator.locks.request(LOCK_NAME, opts, (lock) => {
        if (!lock) { resolve(false); return false; }
        granted = true;
        resolve(true);
        return new Promise((r) => { releaseHeld = r; });
      });
    } catch {
      resolve(null);
      return;
    }
    req.catch(() => {
      // Before a grant: the API refused. After it: another tab stole the lock
      // (AbortError) while this tab owned the save.
      if (!granted) { resolve(null); return; }
      releaseHeld = null;
      becomeBlocked();
    });
  });
}

// Only an owner, or a boot grant that came too late, holds the lock here.
function dropLock() {
  const r = releaseHeld;
  releaseHeld = null;
  r();
}

function goSolo() {
  state = 'solo';
  storage.setWriteGate('open');
}

function becomeOwner() {
  const fresh = state === 'pending' && !storage.diskChanged();
  state = 'owner';
  stopPolling();
  // Boot grace with an untouched save: the copy in memory is current, so open
  // the gate and write what the first moments changed. Otherwise another tab
  // wrote since this tab read the save: main.js leaves the scene first (its
  // exit snapshot lands in the stale copy, still gated), then adopts the disk.
  if (fresh) {
    storage.setWriteGate('open');
    return;
  }
  const adopt = () => {
    storage.reloadFromDisk();
    storage.setWriteGate('open');
  };
  dialogs.consumeBack();   // close the "open in another tab" dialog
  if (onTakeover) onTakeover(adopt);
  else adopt();
}

function becomeBlocked() {
  state = 'blocked';
  storage.setWriteGate('closed');
  pollTimer = setInterval(poll, POLL_MS);   // owners and pending tabs never poll
  showBlocked();
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function poll() {
  if (busy || Date.now() - lastByeAt < BYE_GRACE_MS) return;
  busy = true;
  const got = await tryAcquire(false);
  busy = false;
  if (got) becomeOwner();
}

// The dialog stays up while this tab is blocked: Esc, Back or another dialog
// close it only for a moment, and the loop opens it again.
async function showBlocked() {
  if (showing) return;
  showing = true;
  while (state === 'blocked') {
    const playHere = await dialogs.alert(i18n.t('tab.elsewhere'), { okLabel: i18n.t('tab.playHere') });
    if (playHere && state === 'blocked' && !busy) takeOverHere();
  }
  showing = false;
}

// Play here: a live owner saves and steps aside when asked. A frozen or hung
// owner cannot answer, so after YIELD_WAIT_MS this tab steals the lock anyway.
// A frozen tab saved when it went to the background (main.js flushes on
// visibilitychange), so the steal costs it nothing.
async function takeOverHere() {
  busy = true;
  await askOwnerToYield();
  const got = await tryAcquire(true);
  busy = false;
  if (got) becomeOwner();
}

function askOwnerToYield() {
  return new Promise((resolve) => {
    if (!channel) { resolve(); return; }
    const timer = setTimeout(() => { awaitingYield = null; resolve(); }, YIELD_WAIT_MS);
    awaitingYield = () => { clearTimeout(timer); resolve(); };
    post({ t: 'yield' });
  });
}

function onMessage(e) {
  const t = e?.data?.t;
  if (t === 'bye') {
    lastByeAt = Date.now();
  } else if (t === 'yield' && state === 'owner') {
    storage.flush();   // the last write, while this tab still owns the save
    dropLock();
    becomeBlocked();
    post({ t: 'yielded' });
  } else if (t === 'yielded' && awaitingYield) {
    const done = awaitingYield;
    awaitingYield = null;
    done();
  }
}

function post(msg) {
  if (channel) channel.postMessage(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
