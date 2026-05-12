/** Definition-list key-value grid. `rows` is `Array<[label, valueNodeOrString]>`. */

export function kv(rows) {
  const dl = document.createElement('dl');
  dl.className = 'kv';
  for (const row of rows) {
    if (!row) continue;
    const [label, value] = row;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.appendChild(value);
    else if (value !== null && value !== undefined) dd.textContent = String(value);
    else dd.textContent = '—';
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}
