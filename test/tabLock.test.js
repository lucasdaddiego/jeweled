import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// tabLock.js imports dialogs -> render -> main.js; keep the game from booting.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

// Two "tabs" in one jsdom: each openTab() re-imports storage + dialogs +
// tabLock as a fresh module graph (own save cache, own lock state), while
// localStorage, the fake LockManager and the fake BroadcastChannel bus are
// shared, like two tabs of one origin.

const KEY = 'gem-match:v1';

// Minimal Web Locks: ifAvailable, steal, release when the callback's promise
// settles, crash() for a tab that dies without giving the lock back.
function makeLocks() {
  const held = new Map();
  return {
    held,
    request: vi.fn((name, opts, cb) => new Promise((resolve, reject) => {
      const cur = held.get(name);
      if (cur && opts.ifAvailable) {
        Promise.resolve().then(() => cb(null)).then(resolve, reject);
        return;
      }
      if (cur && !opts.steal) throw new Error('fake locks: waiting requests are not modelled');
      if (cur) { held.delete(name); cur.abort(); }
      const entry = { abort: () => reject(new DOMException('stolen', 'AbortError')) };
      held.set(name, entry);
      Promise.resolve().then(() => cb({ name, mode: 'exclusive' })).then((v) => {
        if (held.get(name) === entry) held.delete(name);
        resolve(v);
      }, reject);
    })),
    crash(name = 'gem-match:tab') { held.delete(name); },
  };
}

// BroadcastChannel bus: delivery to every other open channel of the same name.
const bus = new Set();
class FakeChannel {
  constructor(name) { this.name = name; this.onmessage = null; this.deaf = false; bus.add(this); }
  postMessage(data) {
    for (const ch of bus) {
      if (ch === this || ch.name !== this.name || ch.deaf) continue;
      queueMicrotask(() => ch.onmessage?.({ data }));
    }
  }
  close() { bus.delete(this); }
}

let locks;
const tabs = [];

async function openTab({ onTakeover } = {}) {
  vi.resetModules();
  const storage = await import('../src/storage.js');
  const dialogs = await import('../src/dialogs.js');
  const tabLock = await import('../src/tabLock.js');
  // In-canvas dialog stand-in: alert() stays open until click() or
  // consumeBack(), like the real one.
  const ui = { opened: 0, msg: null, okLabel: null, resolve: null };
  vi.spyOn(dialogs, 'alert').mockImplementation((msg, opts) => new Promise((r) => {
    ui.opened++; ui.msg = msg; ui.okLabel = opts.okLabel; ui.resolve = r;
  }));
  vi.spyOn(dialogs, 'consumeBack').mockImplementation(() => {
    if (!ui.resolve) return false;
    const r = ui.resolve; ui.resolve = null; r(false);
    return true;
  });
  ui.isOpen = () => !!ui.resolve;
  ui.click = (value) => { const r = ui.resolve; ui.resolve = null; r(value); };
  storage.load();
  const tab = { storage, dialogs, tabLock, ui, onTakeover };
  tabs.push(tab);
  return tab;
}

const start = (tab) => tab.tabLock.start(tab.onTakeover ? { onTakeover: tab.onTakeover } : {});
const disk = () => JSON.parse(localStorage.getItem(KEY) || 'null');
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  bus.clear();
  locks = makeLocks();
  vi.stubGlobal('navigator', { ...navigator, locks });
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});

afterEach(() => {
  tabs.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('solo: no lock, writes as before', () => {
  it('when the browser blocks site data', async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('denied', 'SecurityError'); },
    });
    try {
      const a = await openTab();
      start(a);
      expect(a.tabLock.getState()).toBe('solo');
      expect(locks.request).not.toHaveBeenCalled();
      a.storage.saveKey('settings', { haptic: false });
      expect(() => a.storage.flush()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', desc);
    }
  });

  it('when the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', { userAgent: 'old' });
    const a = await openTab();
    start(a);
    expect(a.tabLock.getState()).toBe('solo');
    a.storage.saveKey('profile', { playerName: 'Ann' });
    a.storage.flush();
    expect(disk().profile.playerName).toBe('Ann');
  });

  it('when request() throws or rejects before a grant', async () => {
    locks.request.mockImplementationOnce(() => { throw new TypeError('nope'); });
    const a = await openTab();
    start(a);
    await tick();
    expect(a.tabLock.getState()).toBe('solo');
    locks.request.mockImplementationOnce(() => Promise.reject(new DOMException('denied', 'SecurityError')));
    const b = await openTab();
    start(b);
    await tick();
    expect(b.tabLock.getState()).toBe('solo');
    b.storage.saveKey('profile', { playerName: 'Bea' });
    b.storage.flush();
    expect(disk().profile.playerName).toBe('Bea');
  });
});

describe('one tab', () => {
  it('owns the save after boot and writes what changed while the lock was asked for', async () => {
    const a = await openTab();
    start(a);
    expect(a.tabLock.getState()).toBe('pending');
    a.storage.saveKey('profile', { playerName: 'Ann' });
    a.storage.flush();
    expect(disk()).toBeNull();                  // held until the lock answers
    await tick();
    expect(a.tabLock.getState()).toBe('owner');
    expect(disk().profile.playerName).toBe('Ann');
    expect(a.ui.opened).toBe(0);
  });

  it('works without BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const a = await openTab();
    start(a);
    await tick();
    expect(a.tabLock.getState()).toBe('owner');
    a.tabLock.release();                        // "bye" has no channel: no throw
    expect(a.tabLock.getState()).toBe('pending');
  });
});

describe('a second tab', () => {
  async function twoTabs(bOpts) {
    const a = await openTab();
    start(a);
    await tick();
    a.storage.saveKey('profile', { playerName: 'Ann' });
    a.storage.flush();
    const b = await openTab(bOpts);
    start(b);
    return { a, b };
  }

  it('retries through the boot grace, then blocks and shows "open in another tab"', async () => {
    const { a, b } = await twoTabs();
    await tick(BOOT_GRACE());
    expect(b.tabLock.getState()).toBe('pending');
    await tick(300);
    expect(b.tabLock.getState()).toBe('blocked');
    expect(b.ui.isOpen()).toBe(true);
    expect(b.ui.msg).toMatch(/open in another tab/);
    expect(b.ui.okLabel).toBe('Play here');
    expect(a.tabLock.getState()).toBe('owner');
  });

  it('never writes its stale copy over the owner\'s progress', async () => {
    const { a, b } = await twoTabs();
    await tick(2000);
    a.storage.saveKey('zen', { bestScore: 900 });
    a.storage.flush();
    b.storage.saveKey('zen', { bestScore: 5 });
    b.storage.saveKey('profile', { playerName: 'Stale' });
    b.storage.flush();
    await tick(500);
    expect(disk().zen.bestScore).toBe(900);
    expect(disk().profile.playerName).toBe('Ann');
  });

  it('keeps the dialog up: Esc or Back closes it only for a moment', async () => {
    const { b } = await twoTabs();
    await tick(2000);
    expect(b.ui.opened).toBe(1);
    b.ui.click(false);
    await tick();
    expect(b.ui.opened).toBe(2);
    expect(b.ui.isOpen()).toBe(true);
  });

  it('takes over after the owner closes, on the owner\'s latest save', async () => {
    const onTakeover = vi.fn((adopt) => adopt());
    const { a, b } = await twoTabs({ onTakeover });
    await tick(2000);
    a.storage.saveKey('zen', { bestScore: 777 });
    a.storage.flush();
    a.tabLock.release();                        // pagehide: last write, then the lock goes
    await tick(1000);
    expect(b.tabLock.getState()).toBe('blocked');   // "bye" grace: a reload gets it first
    await tick(4000);
    expect(b.tabLock.getState()).toBe('owner');
    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(b.ui.isOpen()).toBe(false);
    expect(b.storage.load().zen.bestScore).toBe(777);
    b.storage.saveKey('zen', { totalRunsPlayed: 3 });
    b.storage.flush();
    expect(disk().zen).toMatchObject({ bestScore: 777, totalRunsPlayed: 3 });
  });

  it('takes over after the owner crashes (the browser drops its lock, no "bye")', async () => {
    const { b } = await twoTabs();
    await tick(2000);
    locks.crash();
    await tick(2000);
    expect(b.tabLock.getState()).toBe('owner');   // no onTakeover: adopts directly
    expect(b.storage.load().profile.playerName).toBe('Ann');
  });

  it('stays blocked while a reloading owner gets its lock back', async () => {
    const { a, b } = await twoTabs();
    await tick(2000);
    a.tabLock.release();
    const a2 = await openTab();
    start(a2);
    await tick(300);
    expect(a2.tabLock.getState()).toBe('owner');
    await tick(6000);
    expect(b.tabLock.getState()).toBe('blocked');
  });

  it('Play here: the owner saves, steps aside and blocks; this tab takes over', async () => {
    const onTakeover = vi.fn((adopt) => adopt());
    const { a, b } = await twoTabs({ onTakeover });
    await tick(2000);
    a.storage.saveKey('zen', { bestScore: 4242 });   // still in the debounce window
    b.ui.click(true);
    await tick();
    expect(a.tabLock.getState()).toBe('blocked');
    expect(a.ui.isOpen()).toBe(true);
    expect(b.tabLock.getState()).toBe('owner');
    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(b.storage.load().zen.bestScore).toBe(4242);  // flushed by A before it yielded
    a.storage.saveKey('zen', { bestScore: 1 });
    a.storage.flush();
    expect(disk().zen.bestScore).toBe(4242);
  });

  it('Play here: a frozen owner cannot answer, so the lock is stolen after the wait', async () => {
    const { a, b } = await twoTabs();
    await tick(2000);
    for (const ch of bus) if (ch.onmessage && ch !== [...bus].at(-1)) ch.deaf = true;
    b.ui.click(true);
    await tick(500);
    expect(b.tabLock.getState()).toBe('blocked');
    expect(b.ui.isOpen()).toBe(true);           // the dialog stays up while it waits
    b.ui.click(true);                           // a second press while switching: ignored
    await tick(600);
    expect(locks.request.mock.calls.filter((c) => c[1].steal)).toHaveLength(1);
    expect(b.tabLock.getState()).toBe('owner');
    expect(a.tabLock.getState()).toBe('blocked');   // its hold was aborted
  });

  it('Play here stays blocked when the browser refuses the steal', async () => {
    const { a, b } = await twoTabs();
    await tick(2000);
    locks.request.mockImplementationOnce(() => { throw new TypeError('nope'); });
    for (const ch of bus) ch.deaf = true;       // no yield answer: straight to the steal
    b.ui.click(true);
    await tick(1100);
    expect(b.tabLock.getState()).toBe('blocked');
    expect(a.tabLock.getState()).toBe('owner');
    b.ui.click(true);                           // not stuck: a later press tries again
    await tick(1100);
    expect(b.tabLock.getState()).toBe('owner');
  });

  it('blocked again before the old dialog loop wakes: one loop, dialog up', async () => {
    let tabB;
    const onTakeover = vi.fn((adopt) => {
      adopt();
      // A yield request lands in the same task as the takeover, before the
      // dialog loop sees that its dialog closed.
      const ch = [...bus].find((c) => c.tab === tabB);
      ch.onmessage({ data: { t: 'yield' } });
    });
    const a = await openTab();
    start(a);
    await tick();
    const chA = [...bus].at(-1);
    const b = await openTab({ onTakeover });
    tabB = b;
    start(b);
    [...bus].at(-1).tab = b;
    await tick(2000);
    chA.deaf = true;
    locks.crash();
    await tick(2000);
    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(b.tabLock.getState()).toBe('blocked');
    expect(b.ui.isOpen()).toBe(true);
    expect(b.ui.opened).toBe(2);                // the first loop reopened it; no second loop
  });

  it('Play here without BroadcastChannel steals at once', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { a, b } = await twoTabs();
    await tick(2000);
    b.ui.click(true);
    await tick();
    expect(b.tabLock.getState()).toBe('owner');
    expect(a.tabLock.getState()).toBe('blocked');
  });

  it('a boot grant after another tab wrote and closed adopts the disk via onTakeover', async () => {
    const a = await openTab();
    start(a);
    await tick();
    const onTakeover = vi.fn((adopt) => adopt());
    const b = await openTab({ onTakeover });     // reads the save now
    start(b);
    a.storage.saveKey('zen', { bestScore: 31 });
    a.storage.flush();
    a.tabLock.release();
    await tick(300);
    expect(b.tabLock.getState()).toBe('owner');
    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(b.storage.load().zen.bestScore).toBe(31);
  });
});

describe('page lifecycle', () => {
  it('pagehide during the boot request drops a late grant', async () => {
    const a = await openTab();
    start(a);
    a.tabLock.release();                        // before the grant lands
    await tick();
    expect(a.tabLock.getState()).toBe('pending');
    expect(locks.held.size).toBe(0);
  });

  it('pagehide during a boot request that another tab answers "held" stops the loop', async () => {
    const a = await openTab();
    start(a);
    await tick();
    const b = await openTab();
    start(b);
    b.tabLock.release();                        // the ifAvailable answer is still out
    await tick(3000);
    expect(b.tabLock.getState()).toBe('pending');
    expect(b.ui.opened).toBe(0);
  });

  it('pagehide during a boot retry stops the loop', async () => {
    const a = await openTab();
    start(a);
    await tick();
    const b = await openTab();
    start(b);
    await tick(100);
    b.tabLock.release();
    await tick(3000);
    expect(b.tabLock.getState()).toBe('pending');
    expect(b.ui.opened).toBe(0);
  });

  it('back from the back/forward cache asks again; release/reacquire are no-ops otherwise', async () => {
    const a = await openTab();
    a.tabLock.release();                        // solo: nothing to give back
    a.tabLock.reacquire();
    expect(a.tabLock.getState()).toBe('solo');
    start(a);
    await tick();
    a.tabLock.reacquire();                      // owner: nothing to ask for
    expect(a.tabLock.getState()).toBe('owner');
    a.tabLock.release();
    await tick();
    expect(locks.held.size).toBe(0);
    a.tabLock.reacquire();
    await tick();
    expect(a.tabLock.getState()).toBe('owner');
  });

  it('a blocked tab ignores yield requests and release()', async () => {
    const a = await openTab();
    start(a);
    await tick();
    const b = await openTab();
    start(b);
    await tick(2000);
    const c = await openTab();
    start(c);
    await tick(2000);
    c.ui.click(true);                           // asks for a yield: A answers, B must not
    await tick();
    expect(b.tabLock.getState()).toBe('blocked');
    b.tabLock.release();
    expect(b.tabLock.getState()).toBe('blocked');
    expect(c.tabLock.getState()).toBe('owner');
  });
});

function BOOT_GRACE() { return 1400; }
