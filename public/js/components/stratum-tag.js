/** One-letter, color-coded tag for a stratum. */

const SHORT = {
  system: 'S',
  capability: 'C',
  component: 'O',
  interaction: 'I',
  spec: 'P',
};

export function stratumTag(stratum) {
  const el = document.createElement('span');
  el.className = `tag tag-st tag-st-${stratum ?? 'unknown'}`;
  el.title = stratum;
  el.textContent = SHORT[stratum] ?? '?';
  return el;
}
