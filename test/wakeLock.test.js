import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Static import: the module wires its visibilitychange / focus listeners ONCE at
// import time onto the real document/window, so a single import keeps exactly one
// of each handler live (no per-test accumulation). Module state (lock/wanted) is
// reset between cases via release(). The import-time *guard* branches (no
// document / no window) are exercised separately with resetModules at the end.
import * as wakeLock from '../src/wakeLock.js';

// A controllable WakeLockSentinel. addEventListener captures the 'release'
// callback so a test can simulate the OS dropping the lock.
function makeSentinel() {
  const sentinel = {
    _onRelease: null,
    release: vi.fn(() => {}),
    addEventListener: vi.fn((evt, cb) => { if (evt === 'release') sentinel._onRelease = cb; }),
  };
  return sentinel;
}

let sentinel;
let request;
function installWakeLock(requestImpl) {
  request = vi.fn(requestImpl || (() => Promise.resolve(sentinel)));
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
}
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setVisibility('visible');
  sentinel = makeSentinel();
  installWakeLock();
  wakeLock.release(); // reset module state: wanted=false, drop any held lock
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { delete navigator.wakeLock; } catch { /* ignore */ }
  try { delete document.visibilityState; } catch { /* ignore */ }
});

describe('acquire()', () => {
  it('requests a screen lock and registers a one-shot release listener', async () => {
    await wakeLock.acquire();
    expect(request).toHaveBeenCalledWith('screen');
    expect(sentinel.addEventListener).toHaveBeenCalledWith('release', expect.any(Function), { once: true });
  });

  it('is idempotent while a lock is already held', async () => {
    await wakeLock.acquire();
    expect(request).toHaveBeenCalledTimes(1);
    await wakeLock.acquire();                 // lock truthy -> tryRequest returns early
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the Wake Lock API is unsupported', async () => {
    delete navigator.wakeLock;               // !navigator.wakeLock branch
    await expect(wakeLock.acquire()).resolves.toBeUndefined();
  });

  it('is a no-op when navigator is undefined', async () => {
    vi.stubGlobal('navigator', undefined);   // typeof navigator === 'undefined' branch
    await expect(wakeLock.acquire()).resolves.toBeUndefined();
  });

  it('releases an orphaned lock when release() raced ahead of the resolve', async () => {
    let resolveReq;
    installWakeLock(() => new Promise((r) => { resolveReq = r; }));
    const p = wakeLock.acquire();            // wanted=true, awaiting the pending request
    wakeLock.release();                      // wanted=false BEFORE the request resolves
    resolveReq(sentinel);
    await p;
    expect(sentinel.release).toHaveBeenCalled(); // the just-acquired lock is dropped
  });

  it('releases the lock if the page hid before the request resolved', async () => {
    setVisibility('hidden');
    await wakeLock.acquire();
    expect(sentinel.release).toHaveBeenCalled(); // visibilityState !== 'visible' branch
  });

  it('retains the lock when document is undefined (no visibility to check)', async () => {
    vi.stubGlobal('document', undefined);    // typeof document !== 'undefined' === false branch
    await wakeLock.acquire();
    vi.unstubAllGlobals();
    expect(sentinel.release).not.toHaveBeenCalled();
    expect(sentinel.addEventListener).toHaveBeenCalled();
  });

  it('swallows a rejected request (denied / unsupported)', async () => {
    installWakeLock(() => Promise.reject(new Error('denied')));
    await expect(wakeLock.acquire()).resolves.toBeUndefined(); // catch branch
  });
});

describe('automatic re-acquire on the release event', () => {
  it('re-requests when still wanted and visible', async () => {
    await wakeLock.acquire();
    expect(request).toHaveBeenCalledTimes(1);
    sentinel._onRelease();                   // OS dropped the lock
    await tick();
    expect(request).toHaveBeenCalledTimes(2); // re-acquired
  });

  it('does not re-acquire after an explicit release()', async () => {
    await wakeLock.acquire();
    const onRelease = sentinel._onRelease;
    wakeLock.release();                       // wanted=false
    expect(request).toHaveBeenCalledTimes(1);
    onRelease();
    await tick();
    expect(request).toHaveBeenCalledTimes(1); // wanted=false -> no re-acquire
  });

  it('does not re-acquire while the page is hidden', async () => {
    await wakeLock.acquire();
    const onRelease = sentinel._onRelease;
    setVisibility('hidden');
    onRelease();
    await tick();
    expect(request).toHaveBeenCalledTimes(1); // visibility check fails -> no re-acquire
  });

  it('tolerates a missing document in the release callback', async () => {
    await wakeLock.acquire();
    const onRelease = sentinel._onRelease;
    vi.stubGlobal('document', undefined);
    expect(() => onRelease()).not.toThrow();  // typeof document check short-circuits
    vi.unstubAllGlobals();
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('release()', () => {
  it('drops a held lock', async () => {
    await wakeLock.acquire();
    wakeLock.release();
    expect(sentinel.release).toHaveBeenCalled();
  });

  it('is a no-op when no lock is held', () => {
    expect(() => wakeLock.release()).not.toThrow(); // if (lock) -> false branch
  });

  it('tolerates a throwing sentinel.release()', async () => {
    sentinel.release = vi.fn(() => { throw new Error('boom'); });
    await wakeLock.acquire();
    expect(() => wakeLock.release()).not.toThrow(); // try/catch around lock.release()
    expect(sentinel.release).toHaveBeenCalled();
  });
});

describe('visibilitychange listener', () => {
  it('re-acquires when wanted + visible + no lock held', async () => {
    installWakeLock(() => Promise.reject(new Error('no'))); // wanted stays true, lock null
    await wakeLock.acquire();
    expect(request).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores the event when nothing is wanted', async () => {
    document.dispatchEvent(new Event('visibilitychange')); // wanted=false
    await tick();
    expect(request).not.toHaveBeenCalled();
  });

  it('ignores the event while a lock is already held', async () => {
    await wakeLock.acquire();
    document.dispatchEvent(new Event('visibilitychange')); // !lock is false
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores the event while the page is hidden', async () => {
    installWakeLock(() => Promise.reject(new Error('no')));
    await wakeLock.acquire();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange')); // visible check fails
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('window focus listener', () => {
  it('re-acquires when wanted + visible + no lock held', async () => {
    installWakeLock(() => Promise.reject(new Error('no')));
    await wakeLock.acquire();
    expect(request).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores focus when nothing is wanted', async () => {
    window.dispatchEvent(new Event('focus'));
    await tick();
    expect(request).not.toHaveBeenCalled();
  });

  it('ignores focus while a lock is already held', async () => {
    await wakeLock.acquire();
    window.dispatchEvent(new Event('focus'));
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores focus while the page is hidden', async () => {
    installWakeLock(() => Promise.reject(new Error('no')));
    await wakeLock.acquire();
    setVisibility('hidden');
    window.dispatchEvent(new Event('focus'));
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

// These re-import the module with a global missing so the import-time guards run
// their false arms. Kept last so the extra listeners they attach (to a module
// whose `wanted` is always false) can never perturb the dispatch tests above.
describe('import-time environment guards', () => {
  it('skips all listener wiring when document is undefined', async () => {
    vi.resetModules();
    vi.stubGlobal('document', undefined);
    const mod = await import('../src/wakeLock.js');
    expect(typeof mod.acquire).toBe('function'); // imported without throwing
  });

  it('registers visibilitychange but not focus when window is undefined', async () => {
    vi.resetModules();
    const addSpy = vi.spyOn(document, 'addEventListener');
    vi.stubGlobal('window', undefined);
    const mod = await import('../src/wakeLock.js');
    expect(typeof mod.acquire).toBe('function');
    expect(addSpy.mock.calls.some((c) => c[0] === 'visibilitychange')).toBe(true);
    addSpy.mockRestore();
  });
});
