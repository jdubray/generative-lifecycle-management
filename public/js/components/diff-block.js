/** Diff renderer: lines = [{ line, kind: 'add'|'del'|'hunk'|'context' }] */

export function diffBlock(lines) {
  const el = document.createElement('div');
  el.className = 'diff';
  for (const l of lines ?? []) {
    const row = document.createElement('div');
    row.className = `line ${l.kind ?? 'context'}`;
    const prefix = l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : l.kind === 'hunk' ? '' : '  ';
    row.textContent = `${prefix}${l.line ?? ''}`;
    el.appendChild(row);
  }
  return el;
}
