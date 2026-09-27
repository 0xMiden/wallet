// Shared by every surface that renders `DappOrigin` (#1072). `DappOrigin.test.tsx` owns the domain
// span's own classes; what a surface can still break is its ancestors: a wrapper that clips, or a
// row flex item without min-w-0, which will not shrink below its content and pushes the domain out.
const CLIPPING =
  /^(truncate|text-ellipsis|text-clip|whitespace-nowrap|whitespace-pre|line-clamp-\d+|overflow(-[xy])?-(hidden|clip|auto|scroll))$/;

const isRowFlex = (el: Element) =>
  (el.classList.contains('flex') || el.classList.contains('inline-flex')) && !el.classList.contains('flex-col');

/** A clipping class a caller has checked by hand and accepts on one named ancestor. */
export type ClipAllowance = { element: Element; classes: string[] };

/**
 * Fails unless `container` holds `domainEl` (the `dapp-origin-domain` span), nothing from the
 * domain up to and including `container` carries a clipping class outside `allow`, and every
 * element from the domain's parent up to (not including) `container` that sits in a row flex
 * parent carries min-w-0.
 */
export function expectDomainNeverClipped(domainEl: Element, container: Element, allow: ClipAllowance[] = []): void {
  expect(container.contains(domainEl)).toBe(true);

  const chain: Element[] = [];
  for (let node: Element = domainEl; node !== container; node = node.parentElement!) chain.push(node);
  chain.push(container);

  const clipping = chain.flatMap(node => {
    const allowed = allow.filter(a => a.element === node).flatMap(a => a.classes);
    return [...node.classList]
      .filter(name => CLIPPING.test(name) && !allowed.includes(name))
      .map(name => `${name} on <${node.tagName.toLowerCase()} class="${node.className}">`);
  });
  expect(clipping).toEqual([]);

  // Every element strictly between the domain and the container has a parent in the chain.
  const unshrinkable = chain
    .slice(1, -1)
    .filter(node => isRowFlex(node.parentElement!) && !node.classList.contains('min-w-0'))
    .map(node => `<${node.tagName.toLowerCase()} class="${node.className}"> in a row flex parent without min-w-0`);
  expect(unshrinkable).toEqual([]);
}
