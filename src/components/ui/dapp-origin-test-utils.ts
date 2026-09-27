// Shared by every surface that renders `DappOrigin` (#1072): a page-local wrapper that adds a
// clipping class around the domain span would defeat the never-truncate guarantee even though
// `DappOrigin` itself still renders the right classes, so the check has to walk the ancestor
// chain rather than look at the domain element alone.
const CLIPPING_CLASSES = ['truncate', 'text-ellipsis', 'whitespace-nowrap', 'overflow-hidden', 'overflow-x-auto'];
const isLineClamp = (className: string) => /^line-clamp-\d+$/.test(className);

/**
 * Fails unless `domainEl` (the `dapp-origin-domain` span) keeps its no-truncate classes, and
 * neither it nor any ancestor up to and including `container` (the surface's own rendered root)
 * carries a class that would clip its text.
 */
export function expectDomainNeverClipped(domainEl: HTMLElement, container: HTMLElement): void {
  expect(domainEl).toHaveClass('shrink-0', 'break-all', 'max-w-full');

  let node: HTMLElement | null = domainEl;
  while (node) {
    const clipping = [...node.classList].filter(name => CLIPPING_CLASSES.includes(name) || isLineClamp(name));
    expect(clipping).toEqual([]);
    if (node === container) return;
    node = node.parentElement;
  }
  throw new Error('expectDomainNeverClipped: container is not an ancestor of domainEl');
}
