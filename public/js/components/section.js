/** Section card with a header and a body slot. */

export function section({ title, right, tight = false } = {}, ...children) {
  const el = document.createElement('div');
  el.className = 'section';
  const head = document.createElement('div');
  head.className = 'sec-head';
  const titleEl = document.createElement('span');
  titleEl.textContent = title ?? '';
  head.appendChild(titleEl);
  if (right) {
    const rightEl = document.createElement('span');
    rightEl.className = 'right';
    if (right instanceof Node) rightEl.appendChild(right);
    else rightEl.textContent = String(right);
    head.appendChild(rightEl);
  }
  const body = document.createElement('div');
  body.className = `sec-body${tight ? ' tight' : ''}`;
  for (const child of children.flat()) {
    if (child == null) continue;
    body.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  el.appendChild(head);
  el.appendChild(body);
  return el;
}
