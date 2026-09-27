import { expectDomainNeverClipped } from './dapp-origin-test-utils';

// Nests one div per class name, outermost first, inside a bare container, with the domain span innermost.
const tree = (...classNames: string[]) => {
  const container = document.createElement('div');
  const innermost = classNames.reduce<HTMLElement>((parent, className) => {
    const el = parent.appendChild(document.createElement('div'));
    el.className = className;
    return el;
  }, container);
  const domain = innermost.appendChild(document.createElement('span'));
  domain.textContent = 'example.co.uk';
  return { container, domain };
};

describe('expectDomainNeverClipped', () => {
  it.each([
    ['truncate', 'truncate'],
    ['a variant-prefixed clip', 'sm:overflow-hidden'],
    ['a leading important modifier', '!whitespace-nowrap'],
    ['a trailing important modifier', 'whitespace-nowrap!'],
    ['text-nowrap', 'text-nowrap'],
    ['an arbitrary line-clamp', 'line-clamp-[3]']
  ])('fails for %s on an ancestor', (_, className) => {
    const { container, domain } = tree(className);

    expect(() => expectDomainNeverClipped(domain, container)).toThrow(className);
  });

  it.each(['flex', 'grid'])('fails for a %s child without min-w-0', display => {
    const { container, domain } = tree(display, '');

    expect(() => expectDomainNeverClipped(domain, container)).toThrow('without min-w-0');
  });

  it('passes for an allowed class on its named element only', () => {
    const container = document.createElement('div');
    const card = container.appendChild(document.createElement('div'));
    card.className = 'overflow-hidden';
    const row = card.appendChild(document.createElement('div'));
    const domain = row.appendChild(document.createElement('span'));

    expect(() =>
      expectDomainNeverClipped(domain, container, [{ element: card, classes: ['overflow-hidden'] }])
    ).not.toThrow();
    expect(() => expectDomainNeverClipped(domain, container, [{ element: row, classes: ['overflow-hidden'] }])).toThrow(
      'overflow-hidden'
    );
  });
});
