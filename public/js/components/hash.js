/** Truncated sha256 with the full value on hover (AC-05). */

export function hash(value, len = 10) {
  const el = document.createElement('span');
  el.className = 'hash mono';
  if (!value) {
    el.classList.add('muted2');
    el.textContent = '—';
    return el;
  }
  const stripped = String(value).replace(/^sha256:/, '');
  el.title = value;
  el.textContent = stripped.slice(0, len);
  return el;
}
