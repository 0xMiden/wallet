import React from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

import { AnimatedNumber } from './AnimatedNumber';

let mockReduce: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * jsdom has no `matchMedia`, which is exactly the realm the component refuses to animate in — so
 * the default here is the settled value, synchronously, and a test that wants the travelling
 * behaviour opts in by installing one.
 */
function installMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  });
}

function removeMatchMedia() {
  Reflect.deleteProperty(window, 'matchMedia');
}

describe('AnimatedNumber', () => {
  beforeEach(() => {
    mockReduce = false;
    removeMatchMedia();
  });

  afterEach(() => {
    removeMatchMedia();
  });

  describe('mount', () => {
    it('renders the formatted value with no animation, however large it is', () => {
      installMatchMedia();
      render(<AnimatedNumber value={12345.6} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$12345.60');
    });

    it('does not count up when the first number arrives after a placeholder', () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={null} format={usd} placeholder="—" data-testid="n" />);
      expect(screen.getByTestId('n')).toHaveTextContent('—');

      rerender(<AnimatedNumber value={100} format={usd} placeholder="—" data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$100.00');
    });

    it('holds still when a re-render repeats the same value', () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={100} format={usd} data-testid="n" />);
      rerender(<AnimatedNumber value={100} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$100.00');
    });
  });

  describe('change', () => {
    /** Polls the rendered text until it is a number strictly between `low` and `high`. */
    const waitForValueBetween = (low: number, high: number) =>
      waitFor(() => {
        const shown = Number((screen.getByTestId('n').textContent ?? '').replace('$', ''));
        expect(shown).toBeGreaterThan(low);
        expect(shown).toBeLessThan(high);
      });

    it('travels through the values between the old one and the new one', async () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={1000} format={usd} data-testid="n" />);

      // The commit does not flash its destination: the span still reads the old value when the
      // change lands, and only then starts counting.
      expect(screen.getByTestId('n')).toHaveTextContent('$1.00');
      await waitForValueBetween(1, 1000);
      await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('$1000.00'));
    });

    it('lands on the newest value when a second change interrupts the first', async () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={1000} format={usd} data-testid="n" />);
      await waitForValueBetween(1, 1000);
      rerender(<AnimatedNumber value={50} format={usd} data-testid="n" />);

      await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('$50.00'));
    });

    it("does not jump forward to the interrupted count's destination", async () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={1000} format={usd} data-testid="n" />);
      await waitForValueBetween(1, 500);
      rerender(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      // It resumes from wherever the number had got to, not from 1000.
      expect(Number((screen.getByTestId('n').textContent ?? '').replace('$', ''))).toBeLessThan(500);
    });

    it('uses the latest formatter for the frames it draws', async () => {
      installMatchMedia();
      const withUnit = (value: number) => `${value.toFixed(2)} MIDEN`;
      const { rerender } = render(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={100} format={withUnit} data-testid="n" />);

      await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('100.00 MIDEN'));
    });
  });

  // A caller styles a signed figure by its destination's sign (a red or green delta, a toned pill),
  // so a count across zero would show frames of the other sign in that styling.
  describe('a change of sign', () => {
    /** Every text the span shows from now until `ms` have passed. */
    const recordFrames = async (ms: number) => {
      const node = screen.getByTestId('n');
      const frames: string[] = [];
      const observer = new MutationObserver(() => frames.push(node.textContent ?? ''));
      observer.observe(node, { characterData: true, childList: true, subtree: true });
      await act(() => new Promise(resolve => setTimeout(resolve, ms)));
      observer.disconnect();
      return frames;
    };

    it('lands on a negative value without a positive frame on the way', async () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={2.5} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={-1.2} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$-1.20');
      const frames = await recordFrames(800);
      expect(frames.filter(frame => frame !== '$-1.20')).toEqual([]);
      expect(screen.getByTestId('n')).toHaveTextContent('$-1.20');
    });

    it.each([
      ['a negative value to zero', -1.2, 0, '$0.00'],
      ['zero to a positive value', 0, 2.5, '$2.50']
    ])('lands at once going from %s', (_label, from, to, shown) => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={from} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={to} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent(shown);
    });

    it('still travels between two values of the same sign', async () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={2.5} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={3.1} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$2.50');
      await waitFor(() => {
        const shown = Number((screen.getByTestId('n').textContent ?? '').replace('$', ''));
        expect(shown).toBeGreaterThan(2.5);
        expect(shown).toBeLessThan(3.1);
      });
      await waitFor(() => expect(screen.getByTestId('n')).toHaveTextContent('$3.10'));
    });
  });

  describe('reduced motion', () => {
    it('sets the new value immediately', () => {
      installMatchMedia();
      mockReduce = true;
      const { rerender } = render(<AnimatedNumber value={5} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={10} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$10.00');
    });
  });

  describe('a realm that cannot report the motion preference', () => {
    it('sets the new value immediately, so a test reads it synchronously', () => {
      const { rerender } = render(<AnimatedNumber value={5} format={usd} data-testid="n" />);

      rerender(<AnimatedNumber value={10} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('$10.00');
    });
  });

  describe('values that are not numbers', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY]
    ])('renders the placeholder for %s and never calls the formatter', (_label, value) => {
      installMatchMedia();
      const format = jest.fn(usd);
      render(<AnimatedNumber value={value} format={format} placeholder="—" data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('—');
      expect(format).not.toHaveBeenCalled();
    });

    it('renders nothing at all when no placeholder is given', () => {
      render(<AnimatedNumber value={null} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toBeEmptyDOMElement();
    });

    it('takes a node, not just text, as the placeholder', () => {
      render(<AnimatedNumber value={null} format={usd} placeholder={<span data-testid="mask">••••••</span>} />);

      expect(screen.getByTestId('mask')).toBeInTheDocument();
    });

    it('goes back to a placeholder without stranding the last number', () => {
      installMatchMedia();
      const { rerender } = render(<AnimatedNumber value={100} format={usd} placeholder="—" data-testid="n" />);

      rerender(<AnimatedNumber value={null} format={usd} placeholder="—" data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveTextContent('—');
    });

    it('drops the tabular figures while it is not showing a number', () => {
      render(<AnimatedNumber value={null} format={usd} placeholder="—" data-testid="n" />);

      expect(screen.getByTestId('n')).not.toHaveClass('tabular-nums');
    });
  });

  describe('layout and semantics', () => {
    it('sets every digit to the same width so the row does not jitter', () => {
      render(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveClass('tabular-nums');
    });

    it('keeps the caller class alongside the tabular figures', () => {
      render(<AnimatedNumber value={1} format={usd} className="text-ink" data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveClass('tabular-nums', 'text-ink');
    });

    it('opts out of any live region above it, so the count is never announced', () => {
      render(<AnimatedNumber value={1} format={usd} data-testid="n" />);

      expect(screen.getByTestId('n')).toHaveAttribute('aria-live', 'off');
    });
  });
});
