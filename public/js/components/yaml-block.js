/** Monospaced pre-formatted YAML / JSON with lightweight per-line coloring. */

export function yamlBlock(src) {
  const pre = document.createElement('pre');
  pre.className = 'yaml';
  const lines = (src ?? '').split('\n');
  for (const line of lines) {
    const row = document.createElement('div');
    if (/^\s*#/.test(line)) {
      const c = document.createElement('span');
      c.className = 'c';
      c.textContent = line;
      row.appendChild(c);
    } else {
      const m = line.match(/^(\s*[-]?\s*)([A-Za-z_][\w]*)(:\s*)(.*)$/);
      if (m) {
        const [, lead, key, sep, val] = m;
        row.appendChild(document.createTextNode(lead));
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = key;
        row.appendChild(k);
        row.appendChild(document.createTextNode(sep));
        const valSpan = document.createElement('span');
        if (/^["'].*["']$/.test(val)) valSpan.className = 's';
        else if (/^-?\d+(\.\d+)?$/.test(val)) valSpan.className = 'n';
        valSpan.textContent = val;
        row.appendChild(valSpan);
      } else {
        row.textContent = line;
      }
    }
    pre.appendChild(row);
  }
  return pre;
}
