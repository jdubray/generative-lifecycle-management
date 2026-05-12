/** Colored pill for a node's revision status. */

const LABEL = {
  in_work: 'In Work',
  in_review: 'In Review',
  released: 'Released',
  superseded: 'Superseded',
  obsolete: 'Obsolete',
};

export function statusPill(status) {
  const el = document.createElement('span');
  el.className = `pill ${status}`;
  el.innerHTML = `<span class="dot" aria-hidden="true"></span>${LABEL[status] ?? status}`;
  return el;
}
