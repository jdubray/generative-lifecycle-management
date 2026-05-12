/**
 * Hash-based router.
 *
 *   const router = createRouter([
 *     { path: '/', view: () => dashboardView() },
 *     { path: '/sekkei', view: (params) => sekkeiBrowserView(params) },
 *   ]);
 *   router.start(mountEl);
 *
 * Routes accept query-string parameters after `?`, e.g. `#/where-used?glm=glm:capability.x`.
 */

export function createRouter(routes) {
  let currentMount = null;
  let currentDestroy = null;

  function dispatch() {
    const raw = location.hash.slice(1) || '/';
    const [pathRaw, queryRaw = ''] = raw.split('?');
    const path = pathRaw || '/';
    const params = Object.fromEntries(new URLSearchParams(queryRaw));
    const match = routes.find((r) => r.path === path) ?? routes.find((r) => r.path === '*');
    if (!currentMount || !match) return;

    if (currentDestroy) {
      try {
        currentDestroy();
      } catch (e) {
        console.error(e);
      }
      currentDestroy = null;
    }
    currentMount.innerHTML = '';
    currentMount.scrollTop = 0;
    try {
      currentMount.focus({ preventScroll: true });
    } catch {}

    const { element, destroy } = invokeView(match.view, params);
    currentMount.appendChild(element);
    currentDestroy = destroy;
    document.dispatchEvent(new CustomEvent('glm:navigate', { detail: { path, params } }));
  }

  function invokeView(viewFn, params) {
    const result = viewFn(params);
    if (result instanceof HTMLElement) return { element: result, destroy: null };
    return { element: result.element, destroy: result.destroy ?? null };
  }

  function start(mountEl) {
    currentMount = mountEl;
    window.addEventListener('hashchange', dispatch);
    dispatch();
  }

  function navigate(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    location.hash = `#${path}${qs ? `?${qs}` : ''}`;
  }

  return { start, navigate };
}
