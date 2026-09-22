import React from 'react';

import { render } from '@testing-library/react';

import { copyMotion } from 'lib/animation/copy';
import { springs } from 'lib/animation/springs';

import { AnimatedCopyIcon } from './AnimatedCopyIcon';

jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className, fill }: { name: string; className?: string; fill?: string }) => (
    <svg data-name={name} className={className} fill={fill} />
  ),
  IconName: { CopyNew: 'CopyNew', Checkmark: 'Checkmark' }
}));

const mockMotion = { reduce: false };
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockMotion.reduce
}));

const present = (root: Element) => root.querySelector('[data-present="true"]');

beforeEach(() => {
  mockMotion.reduce = false;
});

describe('copyMotion.icon', () => {
  it('morphs the glyph with scale 0.6 → 1, a small turn and a 4px blur, on the tab-bar spring', () => {
    expect(copyMotion.icon.initial).toMatchObject({ scale: 0.6, filter: 'blur(4px)' });
    expect(copyMotion.icon.animate).toMatchObject({ scale: 1, rotate: 0, filter: 'blur(0px)' });
    expect(Math.abs(Number(copyMotion.icon.initial.rotate))).toBeLessThanOrEqual(30);
    expect(copyMotion.icon.transition).toMatchObject(springs.tabSwitch);
  });
});

describe('AnimatedCopyIcon', () => {
  it('shows the copy mark at rest and the check once copied, painting the check in currentColor', () => {
    const { container, rerender } = render(<AnimatedCopyIcon copied={false} />);
    const box = container.querySelector('[data-copy-icon]')!;
    expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(present(box)?.querySelector('[data-name="CopyNew"]')).toBeInTheDocument();

    rerender(<AnimatedCopyIcon copied checkClassName="text-positive-ink" />);
    const check = present(box)?.querySelector('[data-name="Checkmark"]');
    expect(check).toHaveAttribute('fill', 'currentColor');
    expect(check).toHaveClass('text-positive-ink');
  });

  it('marks the glyph morphing out as not present', () => {
    const { container, rerender } = render(<AnimatedCopyIcon copied={false} />);
    rerender(<AnimatedCopyIcon copied />);

    const leaving = container.querySelector('[data-present="false"]');
    expect(leaving).toHaveAttribute('data-copy-state', 'idle');
    expect(leaving).toHaveAttribute('aria-hidden', 'true');
    expect(present(container)).toHaveAttribute('data-copy-state', 'copied');
  });

  it('sizes its box from `size`, and a caller class can fill a parent box instead', () => {
    const { container, rerender } = render(<AnimatedCopyIcon copied={false} size="sm" />);
    expect(container.querySelector('[data-copy-icon]')).toHaveClass('w-5', 'h-5');

    rerender(<AnimatedCopyIcon copied={false} className="h-full w-full" />);
    const box = container.querySelector('[data-copy-icon]')!;
    expect(box).toHaveClass('h-full', 'w-full');
    expect(box).not.toHaveClass('w-4');
  });

  it('swaps instantly under reduced motion, with no blur or rotation', () => {
    mockMotion.reduce = true;
    const { container, rerender } = render(<AnimatedCopyIcon copied={false} />);
    rerender(<AnimatedCopyIcon copied />);

    const states = container.querySelectorAll<HTMLElement>('[data-copy-state]');
    expect(states).toHaveLength(1);
    expect(states[0]).toHaveAttribute('data-copy-state', 'copied');
    expect(states[0]!.style.filter).toBe('');
    expect(states[0]!.style.transform).toBe('');
  });
});
