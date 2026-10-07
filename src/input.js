// Pointer/touch input → grid coords. Tap-tap to swap.

import { screenToCell } from './render.js';

let canvas = null;
let listeners = { onTapCell: null, onMove: null, onUp: null, onWheel: null, onCancel: null, onKey: null };

let lastPointerX = 0;
let lastPointerY = 0;
let activePointerId = null;
let pointerIsDown = false;

export function setup() {
  canvas = document.getElementById('game');

  // Use pointer events (works on touch + mouse).
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup',   onPointerUp);
  // pointercancel fires when the OS steals the pointer (notification swipe,
  // edge gesture, phone call). Treat as cancel — otherwise the active drag
  // gets stuck because pointerup is never delivered.
  canvas.addEventListener('pointercancel', onPointerCancel);
  // Window blur covers a related case: focus moves to a different app while
  // the finger is still down. Also treat as cancel.
  window.addEventListener('blur', () => onPointerCancel());
  // Prevent context menu on long-press.
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // Wheel for scrollable scenes.
  canvas.addEventListener('wheel', onWheel, { passive: false });
  // Keyboard play (index.html gives the canvas tabindex=0). Keys reach the
  // canvas only while it has focus, so the page's DOM inputs keep theirs.
  canvas.addEventListener('keydown', onKeydown);
}

function onWheel(e) {
  if (listeners.onWheel) {
    e.preventDefault();
    listeners.onWheel(e.deltaY, e.clientX, e.clientY);
  }
}

// onKey(key, shift) returns true when it consumed the key; only then is the
// browser default (Tab moving focus, Space scrolling) suppressed. Shortcuts
// with a modifier stay with the browser (Cmd+R, Ctrl+Tab, Alt+Left).
function onKeydown(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (listeners.onKey && listeners.onKey(e.key, e.shiftKey)) e.preventDefault();
}

export function on(events) {
  Object.assign(listeners, events);
}

function onPointerDown(e) {
  if (activePointerId !== null) return;
  const x = e.clientX, y = e.clientY;
  lastPointerX = x; lastPointerY = y;
  activePointerId = e.pointerId;
  pointerIsDown = true;
  // setPointerCapture so move/up keep firing on the canvas even if the user's
  // finger drags off-screen. Without this, a drag off the edge stops receiving
  // events and the dragged gem is left visually offset.
  try { canvas.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  const cell = screenToCell(x, y);
  if (listeners.onTapCell) listeners.onTapCell(cell, x, y);
}

function onPointerMove(e) {
  if (activePointerId !== null && e.pointerId !== activePointerId) return;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  if (listeners.onMove) listeners.onMove(e.clientX, e.clientY);
}

function onPointerUp(e) {
  if (activePointerId !== e.pointerId) return;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* unsupported */ }
  activePointerId = null;
  pointerIsDown = false;
  if (listeners.onUp) listeners.onUp(e.clientX, e.clientY);
}

function onPointerCancel(e) {
  if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
  if (e && activePointerId === e.pointerId) {
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* unsupported */ }
  }
  activePointerId = null;
  pointerIsDown = false;
  if (listeners.onCancel) listeners.onCancel(lastPointerX, lastPointerY);
}

export function isPointerDown() {
  return pointerIsDown;
}

// --- Release-activated buttons ----------------------------------------------
// Canvas buttons fire on pointerdown so the UI feels instant. Actions that need
// transient user activation (Web Share, clipboard writes, window.open) can't:
// per the HTML spec a touch `pointerdown` is NOT an activation-triggering event
// (only mousedown, a mouse pointerdown, a non-mouse pointerup, touchend and
// keydown are), so on a phone, a few seconds after the last tap, navigator.share
// rejects with NotAllowedError and window.open is popup-blocked. Such buttons
// carry `activateOnUp` and fire on the release of a press that started on the
// same button; each scene that has one keeps a tracker.

export function hitTest(b, x, y) {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

export function createPressTracker() {
  let pending = null;
  return {
    // 'down' over an activateOnUp button: remember it, fire nothing yet.
    arm(button) { pending = button; },
    // 'up': fire only if the release lands on the button the press started on.
    // A press released elsewhere, or one that started elsewhere, is dropped.
    release(x, y) {
      const b = pending;
      pending = null;
      if (b && hitTest(b, x, y)) b.onClick();
    },
    // pointercancel (OS gesture, blur) or a scene change: drop the press.
    cancel() { pending = null; },
  };
}
