export { statusPill } from './status-pill.js';
export { stratumTag } from './stratum-tag.js';
export { classBadge } from './class-badge.js';
export { hash } from './hash.js';
export { section } from './section.js';
export { kv } from './kv.js';
export { diffBlock } from './diff-block.js';
export { yamlBlock } from './yaml-block.js';
export { empty } from './empty.js';

/**
 * Helper: build an element with attributes + children.
 *
 * Intentionally has NO `html:` / `innerHTML` escape hatch — every text
 * child is passed through `createTextNode`, which makes XSS via attribute
 * keys impossible at this layer. If you really need to inject HTML, build
 * the subtree with this helper and append it; do not introduce a string
 * sink.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'onClick') node.addEventListener('click', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
