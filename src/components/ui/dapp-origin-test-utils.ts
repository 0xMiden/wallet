// Shared by every surface that renders `DappOrigin` (#1072). `DappOrigin.test.tsx` owns the domain
// span's own classes; what a surface can still break is its ancestors: a wrapper that clips, or a
// row flex or grid item without min-w-0, which will not shrink below its content and pushes the domain out.
const CLIPPING =
  /^(truncate|text-ellipsis|text-clip|text-nowrap|whitespace-nowrap|whitespace-pre|line-clamp-(\d+|\[[^\]]+\]|\([^)]+\))|overflow(-[xy])?-(hidden|clip|auto|scroll))$/;

// A hazard counts under any variant (sm:, hover:) and with Tailwind's important modifier, leading in
// v3 and trailing in v4; the protections (min-w-0, flex-col) count only when unconditional.
const utility = (name: string) => (name.split(':').pop() ?? name).replace(/^!|!$/g, '');

const needsMinW0 = (parent: Element) => {
  const names = [...parent.classList].map(utility);
  const isGrid = names.includes('grid') || names.includes('inline-grid');
  const isRowFlex = (names.includes('flex') || names.includes('inline-flex')) && !parent.classList.contains('flex-col');
  return isGrid || isRowFlex;
};

/** A clipping class a caller has checked by hand and accepts on one named ancestor. */
export type ClipAllowance = { element: Element; classes: string[] };

/**
 * Fails unless `container` holds `domainEl` (the `dapp-origin-domain` span), nothing from the
 * domain up to and including `container` carries a clipping class outside `allow`, and every
 * element from the domain's parent up to (not including) `container` that sits in a row flex or
 * grid parent carries min-w-0.
 */
export function expectDomainNeverClipped(domainEl: Element, container: Element, allow: ClipAllowance[] = []): void {
  expect(container.contains(domainEl)).toBe(true);

  const chain: Element[] = [];
  for (let node: Element = domainEl; node !== container; node = node.parentElement!) chain.push(node);
  chain.push(container);

  const clipping = chain.flatMap(node => {
    const allowed = allow.filter(a => a.element === node).flatMap(a => a.classes);
    return [...node.classList]
      .filter(name => CLIPPING.test(utility(name)) && !allowed.includes(name))
      .map(name => `${name} on <${node.tagName.toLowerCase()} class="${node.className}">`);
  });
  expect(clipping).toEqual([]);

  // Every element strictly between the domain and the container has a parent in the chain.
  const unshrinkable = chain
    .slice(1, -1)
    .filter(node => needsMinW0(node.parentElement!) && !node.classList.contains('min-w-0'))
    .map(
      node => `<${node.tagName.toLowerCase()} class="${node.className}"> in a row flex or grid parent without min-w-0`
    );
  expect(unshrinkable).toEqual([]);
}
