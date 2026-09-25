import React from 'react';

import { render } from '@testing-library/react';

import { copyMotion } from 'lib/animation/copy';
import { springs } from 'lib/animation/springs';

import { CopyLabel } from './CopyLabel';

const mockMotion = { reduce: false };
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockMotion.reduce
}));

const present = (root: Element) => root.querySelector('[data-present="true"]');

beforeEach(() => {
  mockMotion.reduce = false;
});

describe('copyMotion.label', () => {
  it('rolls the label up out of the slot as the new one rises from below, on the same spring', () => {
    expect(copyMotion.label.initial).toMatchObject({ y: '100%' });
    expect(copyMotion.label.exit).toMatchObject({ y: '-100%' });
    expect(copyMotion.label.transition).toMatchObject(springs.tabSwitch);
  });
});

describe('CopyLabel', () => {
  it('rolls from its label to the copied label and back', () => {
    const { container, rerender } = render(
      <CopyLabel copied={false} copiedLabel="Copied">
        Copy
      </CopyLabel>
    );
    expect(present(container)).toHaveTextContent('Copy');

    rerender(
      <CopyLabel copied copiedLabel="Copied">
        Copy
      </CopyLabel>
    );
    expect(present(container)).toHaveTextContent('Copied');

    rerender(
      <CopyLabel copied={false} copiedLabel="Copied">
        Copy
      </CopyLabel>
    );
    expect(present(container)).toHaveTextContent(/^Copy$/);
  });

  it('clips the roll vertically and still truncates a long label', () => {
    const { container } = render(
      <CopyLabel copied={false} copiedLabel="Copied">
        mtst1aq6longaddress
      </CopyLabel>
    );
    expect(container.querySelector('[data-copy-label]')).toHaveClass('overflow-y-clip', 'min-w-0');
    expect(present(container)).toHaveClass('truncate');
  });

  it('swaps instantly under reduced motion', () => {
    mockMotion.reduce = true;
    const { container, rerender } = render(
      <CopyLabel copied={false} copiedLabel="Copied">
        Copy
      </CopyLabel>
    );
    rerender(
      <CopyLabel copied copiedLabel="Copied">
        Copy
      </CopyLabel>
    );

    expect(container.querySelectorAll('[data-copy-state]')).toHaveLength(1);
    expect(present(container)).toHaveTextContent('Copied');
  });
});
