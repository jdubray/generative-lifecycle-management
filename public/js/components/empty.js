/** Empty-state placeholder. */

export function empty(message) {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = message ?? 'Nothing here yet.';
  return el;
}
