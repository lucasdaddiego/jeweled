// Pointer/touch input → grid coords. Tap-tap to swap.

import { screenToCell } from './render.js';

let canvas = null;
let listeners = { onTapCell: null, onMove: null, onUp: null, onWheel: null, onCancel: null };

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
}

function onWheel(e) {
  if (listeners.onWheel) {
    e.preventDefault();
    listeners.onWheel(e.deltaY, e.clientX, e.clientY);
  }
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

export function getCursor() {
  return { x: lastPointerX, y: lastPointerY };
}

export function isPointerDown() {
  return pointerIsDown;
}
