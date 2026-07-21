import React from 'react';

import { render, screen } from '@testing-library/react';

import BootAnimation from './BootAnimation';

// `BootAnimation` is a thin wrapper: it seeds `booted=false`, flips it to `true`
// inside a layout effect on mount, and hands its children to a
// react-transition-group <CSSTransition> whose `timeout` is `0` in the
// extension build and `200` everywhere else (`isExtension() ? 0 : 200`).
//
// We drive `isExtension` through a jest.fn so each test can pick the branch,
// and we replace the real CSSTransition (which reaches for `findDOMNode`) with
// a passthrough that records the `in` / `timeout` props it was rendered with
// and projects the children — that lets us assert the computed props directly
// while still verifying the subtree mounts.
const mockIsExtension = jest.fn();
jest.mock('lib/platform', () => ({ isExtension: () => mockIsExtension() }));

const mockCssTransitionCalls: Array<{ in: boolean; timeout: number }> = [];
jest.mock('react-transition-group/CSSTransition', () => {
  // Require React inside the factory so the hoisted mock has no out-of-scope
  // reference to the top-level import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLocal = require('react');
  return {
    __esModule: true,
    default: (props: { in: boolean; timeout: number; children: React.ReactNode }) => {
      mockCssTransitionCalls.push({ in: props.in, timeout: props.timeout });
      return ReactLocal.createElement('div', { 'data-testid': 'transition' }, props.children);
    }
  };
});

beforeEach(() => {
  mockCssTransitionCalls.length = 0;
  mockIsExtension.mockReset();
});

describe('BootAnimation', () => {
  it('renders its children through the transition and boots via the layout effect', () => {
    mockIsExtension.mockReturnValue(false);

    render(
      <BootAnimation>
        <span data-testid="child">hello</span>
      </BootAnimation>
    );

    // Children are projected through the CSSTransition wrapper.
    expect(screen.getByTestId('transition')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('hello');

    // The layout effect flips `booted` false -> true, so the first render has
    // `in=false` and the final (post-effect) render has `in=true`.
    expect(mockCssTransitionCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockCssTransitionCalls[0]!.in).toBe(false);
    expect(mockCssTransitionCalls.at(-1)!.in).toBe(true);
  });

  it('uses a 200ms timeout when NOT running as an extension', () => {
    mockIsExtension.mockReturnValue(false);

    render(
      <BootAnimation>
        <div data-testid="child">web</div>
      </BootAnimation>
    );

    expect(mockIsExtension).toHaveBeenCalled();
    // Every render (initial + post-effect) computes the non-extension timeout.
    expect(mockCssTransitionCalls.every(c => c.timeout === 200)).toBe(true);
    expect(mockCssTransitionCalls.at(-1)!.timeout).toBe(200);
  });

  it('uses a 0ms timeout when running as an extension', () => {
    mockIsExtension.mockReturnValue(true);

    render(
      <BootAnimation>
        <div data-testid="child">ext</div>
      </BootAnimation>
    );

    expect(mockIsExtension).toHaveBeenCalled();
    // Extension build short-circuits the animation with a zero timeout.
    expect(mockCssTransitionCalls.every(c => c.timeout === 0)).toBe(true);
    expect(mockCssTransitionCalls.at(-1)!.timeout).toBe(0);
    // Children still render regardless of the timeout branch.
    expect(screen.getByTestId('child')).toHaveTextContent('ext');
  });
});
