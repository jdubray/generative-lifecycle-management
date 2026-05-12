/**
 * Tiny observable store. Replaces window.__glm from the mockup.
 *
 *   const store = createStore({ count: 0 });
 *   store.subscribe((s) => render(s.count));
 *   store.set({ count: s.count + 1 });
 *
 * `subscribe` returns an `unsubscribe` callback. `select(fn)` lets a caller
 * subscribe to a derived slice and only fire when that slice changes.
 */

export function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    state = { ...state, ...patch };
    for (const fn of subs) fn(state);
  }

  function subscribe(fn) {
    subs.add(fn);
    fn(state);
    return () => subs.delete(fn);
  }

  function select(selector, fn) {
    let prev = selector(state);
    return subscribe((s) => {
      const next = selector(s);
      if (!Object.is(next, prev)) {
        prev = next;
        fn(next);
      }
    });
  }

  return { get, set, subscribe, select };
}
