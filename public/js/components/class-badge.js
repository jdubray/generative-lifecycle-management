/** Class I / II badge for SCRs. */

export function classBadge(cls) {
  const el = document.createElement('span');
  el.className = `pill ${cls === 'I' ? 'warn' : 'outline'}`;
  el.textContent = `Class ${cls}`;
  return el;
}
