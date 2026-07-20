import React from 'react';

import { render } from '@testing-library/react';

import AnimalIdenticon from './AnimalIdenticon';

// AnimalIdenticon is a self-contained presentational atom. Its only external
// deps are:
//   - `app/icons/animals.svg` → stubbed by jest's `svgMock.js` to the string
//     'svg', so `AnimalIcons` renders as a plain <svg> DOM element carrying the
//     computed width/height/viewBox/style/className props.
//   - `randomcolor` (seeded) and `seedrandom` — both pure, deterministic JS
//     that run fine under jsdom, so (mirroring Identicon.test.tsx) we exercise
//     them for real rather than mocking, keeping the component + its private
//     `getAnimalIndex` / `indexToViewBox` helpers fully covered.
//
// The `if (index < 0 || index > 19) throw` guard inside `indexToViewBox` is
// unreachable through the public component: the index always comes from
// `Math.floor(seededRng() * 19)`, i.e. an integer in [0, 18]. That defensive
// throw is the only line that stays uncovered.

// Mirror of the source's private `indexToMinY` lookup so we can assert the
// rendered viewBox is a legitimate slot from the sprite sheet.
const INDEX_TO_MIN_Y = [
  -20, 580, 1200, 1850, 2490, 3110, 3780, 4450, 5050, 5650, 6250, 6800, 7350, 7950, 8550, 9150, 9700, 10300, 10960
];
const VALID_VIEW_BOXES = new Set(INDEX_TO_MIN_Y.map(minY => `0 ${minY} 630 610`));

const getSvg = (container: HTMLElement) => container.querySelector('svg') as SVGElement;

describe('AnimalIdenticon', () => {
  it('renders an <svg> with the default size (100) and a valid seeded viewBox', () => {
    const { container } = render(<AnimalIdenticon publicKey="alice" />);
    const svg = getSvg(container);

    expect(svg).toBeInTheDocument();
    // svgMock renders the ReactComponent as the string 'svg' → real <svg> node.
    expect(svg.tagName.toLowerCase()).toBe('svg');

    // default size = 100 flows to both width and height attributes.
    expect(svg).toHaveAttribute('width', '100');
    expect(svg).toHaveAttribute('height', '100');

    // viewBox is one of the 19 valid sprite-sheet slots: `0 <minY> 630 610`.
    const viewBox = svg.getAttribute('viewBox');
    expect(viewBox).toMatch(/^0 -?\d+ 630 610$/);
    expect(VALID_VIEW_BOXES.has(viewBox as string)).toBe(true);

    // seeded background colour is applied inline (jsdom normalises to rgb()).
    expect(svg.style.backgroundColor).toBeTruthy();
  });

  it('applies a custom size to both width and height', () => {
    const { container } = render(<AnimalIdenticon publicKey="bob" size={42} />);
    const svg = getSvg(container);

    expect(svg).toHaveAttribute('width', '42');
    expect(svg).toHaveAttribute('height', '42');
  });

  it('merges a provided className after the base "rounded-full" class', () => {
    const { container } = render(<AnimalIdenticon publicKey="carol" className="my-extra-class" />);
    const svg = getSvg(container);

    expect(svg).toHaveClass('rounded-full', 'my-extra-class');
    expect(svg.getAttribute('class')).toBe('rounded-full my-extra-class');
  });

  it('falls back to the stringified undefined className when none is provided', () => {
    // `className` defaults to undefined → `'rounded-full ' + undefined`.
    const { container } = render(<AnimalIdenticon publicKey="dave" />);
    const svg = getSvg(container);

    expect(svg).toHaveClass('rounded-full');
    expect(svg.getAttribute('class')).toBe('rounded-full undefined');
  });

  it('is deterministic: the same publicKey yields the same colour and viewBox', () => {
    const first = render(<AnimalIdenticon publicKey="stable-key" />);
    const firstSvg = getSvg(first.container);
    const firstColor = firstSvg.style.backgroundColor;
    const firstViewBox = firstSvg.getAttribute('viewBox');
    first.unmount();

    const second = render(<AnimalIdenticon publicKey="stable-key" />);
    const secondSvg = getSvg(second.container);

    expect(secondSvg.style.backgroundColor).toBe(firstColor);
    expect(secondSvg.getAttribute('viewBox')).toBe(firstViewBox);
    expect(VALID_VIEW_BOXES.has(firstViewBox as string)).toBe(true);
  });

  it('maps different publicKeys to valid (and generally distinct) animal viewBoxes', () => {
    // Exercise `getAnimalIndex` / `indexToViewBox` across many seeds. Every
    // result must be a legitimate slot, and the set of keys should surface more
    // than one distinct animal (guards against an accidental constant index).
    const keys = [
      'k0',
      'k1',
      'k2',
      'k3',
      'k4',
      'k5',
      'k6',
      'k7',
      'k8',
      'k9',
      'account-0xabc',
      'account-0xdef',
      'zzz',
      'the-quick-brown-fox'
    ];

    const seen = new Set<string>();
    for (const key of keys) {
      const { container, unmount } = render(<AnimalIdenticon publicKey={key} />);
      const viewBox = getSvg(container).getAttribute('viewBox') as string;
      expect(VALID_VIEW_BOXES.has(viewBox)).toBe(true);
      seen.add(viewBox);
      unmount();
    }

    expect(seen.size).toBeGreaterThan(1);
  });
});
