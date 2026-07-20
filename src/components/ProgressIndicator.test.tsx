import React from 'react';

import { render, screen } from '@testing-library/react';

import { ProgressIndicator } from './ProgressIndicator';

// Pin the brand hex so the "filled" animate branch is assertable regardless of
// which network build (devnet vs mainnet) supplies PRIMARY_500.
jest.mock('utils/brand-colors', () => ({
  PRIMARY_500: '#E77537'
}));

// framer-motion's <motion.div> is each progress bar. Replace it with a plain
// div that surfaces the animate / initial / transition props as
// data-attributes so the fill/width branches are observable in jsdom.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ animate, initial, transition, className, ...rest }: any) => (
      <div
        data-testid="bar"
        data-animate={JSON.stringify(animate ?? null)}
        data-initial={String(initial)}
        data-transition={JSON.stringify(transition ?? null)}
        className={className}
        {...rest}
      />
    )
  }
}));

const FILLED_COLOR = '#E77537';
const EMPTY_COLOR = '#D9D9D9';
const ACTIVE_WIDTH = 54;
const INACTIVE_WIDTH = 42;

const getBars = () => screen.queryAllByTestId('bar');
const animateOf = (bar: HTMLElement) => JSON.parse(bar.getAttribute('data-animate') as string);

describe('ProgressIndicator', () => {
  describe('rendering', () => {
    it('renders one bar per step', () => {
      render(<ProgressIndicator steps={4} currentStep={1} />);

      expect(getBars()).toHaveLength(4);
    });

    it('renders no bars when steps is 0', () => {
      const { container } = render(<ProgressIndicator steps={0} currentStep={0} />);

      expect(getBars()).toHaveLength(0);
      // Outer container still renders.
      expect(container.querySelector('div.flex')).toBeInTheDocument();
    });

    it('renders the outer container with the base layout classes', () => {
      const { container } = render(<ProgressIndicator steps={3} currentStep={1} />);
      const outer = container.firstChild as HTMLElement;

      expect(outer).toHaveClass('flex', 'items-center', 'gap-0.5');
    });

    it('gives each bar the base bar classes', () => {
      render(<ProgressIndicator steps={2} currentStep={1} />);

      getBars().forEach((bar) => {
        expect(bar).toHaveClass('h-1.5', 'rounded-full');
      });
    });
  });

  describe('fill state (isFilled = index <= currentStep - 1)', () => {
    it('fills bars up to the current step and leaves later bars empty', () => {
      render(<ProgressIndicator steps={4} currentStep={2} />);
      const bars = getBars();

      // currentStep=2 → indices 0,1 filled; indices 2,3 empty.
      expect(animateOf(bars[0])).toEqual({ width: ACTIVE_WIDTH, backgroundColor: FILLED_COLOR });
      expect(animateOf(bars[1])).toEqual({ width: ACTIVE_WIDTH, backgroundColor: FILLED_COLOR });
      expect(animateOf(bars[2])).toEqual({ width: INACTIVE_WIDTH, backgroundColor: EMPTY_COLOR });
      expect(animateOf(bars[3])).toEqual({ width: INACTIVE_WIDTH, backgroundColor: EMPTY_COLOR });
    });

    it('leaves every bar empty when currentStep is 0', () => {
      render(<ProgressIndicator steps={3} currentStep={0} />);

      getBars().forEach((bar) => {
        expect(animateOf(bar)).toEqual({ width: INACTIVE_WIDTH, backgroundColor: EMPTY_COLOR });
      });
    });

    it('fills every bar when currentStep equals steps', () => {
      render(<ProgressIndicator steps={3} currentStep={3} />);

      getBars().forEach((bar) => {
        expect(animateOf(bar)).toEqual({ width: ACTIVE_WIDTH, backgroundColor: FILLED_COLOR });
      });
    });

    it('fills every bar when currentStep exceeds steps', () => {
      render(<ProgressIndicator steps={2} currentStep={5} />);

      getBars().forEach((bar) => {
        expect(animateOf(bar)).toEqual({ width: ACTIVE_WIDTH, backgroundColor: FILLED_COLOR });
      });
    });
  });

  describe('motion props', () => {
    it('disables the initial animation and uses the configured transition', () => {
      render(<ProgressIndicator steps={1} currentStep={1} />);
      const bar = getBars()[0];

      expect(bar).toHaveAttribute('data-initial', 'false');
      expect(JSON.parse(bar.getAttribute('data-transition') as string)).toEqual({
        duration: 0.3,
        ease: [0.4, 0, 0.2, 1]
      });
    });
  });

  describe('props forwarding', () => {
    it('appends a custom className to the base container classes', () => {
      const { container } = render(<ProgressIndicator steps={2} currentStep={1} className="my-custom" />);
      const outer = container.firstChild as HTMLElement;

      expect(outer).toHaveClass('flex', 'items-center', 'gap-0.5', 'my-custom');
    });

    it('forwards extra HTML attributes to the outer container', () => {
      render(<ProgressIndicator steps={2} currentStep={1} id="progress" data-testid="pi" aria-label="progress" />);
      const outer = screen.getByTestId('pi');

      expect(outer).toHaveAttribute('id', 'progress');
      expect(outer).toHaveAttribute('aria-label', 'progress');
    });
  });
});
