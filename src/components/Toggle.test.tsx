import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticMedium } from 'lib/mobile/haptics';

import { Toggle } from './Toggle';

// Control isExtension() per-test via a mutable flag (mock-prefixed so the
// hoisted jest.mock factory may reference it).
let mockIsExtension = false;
jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension
}));

// Haptics is a native bridge — stub it so we can assert it fires.
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn()
}));

// Pin the brand hex so the `value=false` animate branch is assertable.
jest.mock('utils/brand-colors', () => ({
  PRIMARY_HEX: '#E77537'
}));

// framer-motion's <motion.div> is replaced by a plain div that surfaces the
// animate / layout / transition props as data-attributes for assertion.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    div: ({ animate, layout, transition, className, ...rest }: any) => (
      <div
        data-testid="toggle-thumb"
        data-animate={JSON.stringify(animate ?? null)}
        data-layout={String(layout)}
        data-transition={JSON.stringify(transition ?? null)}
        className={className}
        {...rest}
      />
    )
  }
}));

const getToggle = () => screen.getByTestId('toggle');
const getThumb = () => screen.getByTestId('toggle-thumb');

describe('Toggle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsExtension = false;
  });

  describe('rendering', () => {
    it('renders the outer track and the motion thumb', () => {
      render(<Toggle data-testid="toggle" />);

      expect(getToggle()).toBeInTheDocument();
      expect(getThumb()).toBeInTheDocument();
    });

    it('always applies the base track classes', () => {
      render(<Toggle data-testid="toggle" />);

      expect(getToggle()).toHaveClass(
        'w-10',
        'h-5',
        'rounded-full',
        'cursor-pointer',
        'flex',
        'border',
        'items-center',
        'px-1'
      );
    });

    it('always applies the base thumb classes', () => {
      render(<Toggle data-testid="toggle" />);

      expect(getThumb()).toHaveClass('w-3', 'h-3', 'rounded-full');
    });

    it('merges a custom className onto the track', () => {
      render(<Toggle data-testid="toggle" className="my-custom-class" />);

      expect(getToggle()).toHaveClass('my-custom-class');
    });

    it('spreads extra props onto the track element', () => {
      render(<Toggle data-testid="toggle" aria-label="feature toggle" id="the-toggle" />);

      const el = getToggle();
      expect(el).toHaveAttribute('aria-label', 'feature toggle');
      expect(el).toHaveAttribute('id', 'the-toggle');
    });
  });

  describe('value=false (default / off state)', () => {
    it('uses the "off" track classes when value is omitted', () => {
      render(<Toggle data-testid="toggle" />);

      const el = getToggle();
      expect(el).toHaveClass('justify-start', 'bg-white', 'border-border-light');
      expect(el).not.toHaveClass('justify-end', 'bg-primary-500', 'border-primary-500');
    });

    it('uses the "off" thumb class and animates toward the brand hex', () => {
      render(<Toggle data-testid="toggle" value={false} />);

      const thumb = getThumb();
      expect(thumb).toHaveClass('bg-primary-500');
      expect(thumb).not.toHaveClass('bg-white');
      expect(JSON.parse(thumb.getAttribute('data-animate') as string)).toEqual({
        backgroundColor: '#E77537'
      });
    });
  });

  describe('value=true (on state)', () => {
    it('uses the "on" track classes', () => {
      render(<Toggle data-testid="toggle" value />);

      const el = getToggle();
      expect(el).toHaveClass('justify-end', 'bg-primary-500', 'border-primary-500');
      expect(el).not.toHaveClass('justify-start', 'bg-white', 'border-border-light');
    });

    it('uses the "on" thumb class and animates toward white', () => {
      render(<Toggle data-testid="toggle" value />);

      const thumb = getThumb();
      expect(thumb).toHaveClass('bg-white');
      expect(thumb).not.toHaveClass('bg-primary-500');
      expect(JSON.parse(thumb.getAttribute('data-animate') as string)).toEqual({
        backgroundColor: '#ffffff'
      });
    });
  });

  describe('disabled state', () => {
    it('applies the disabled track classes when disabled', () => {
      render(<Toggle data-testid="toggle" disabled />);

      expect(getToggle()).toHaveClass('opacity-50', 'cursor-not-allowed');
    });

    it('does not apply disabled classes by default', () => {
      render(<Toggle data-testid="toggle" />);

      const el = getToggle();
      expect(el).not.toHaveClass('opacity-50');
      expect(el).not.toHaveClass('cursor-not-allowed');
    });
  });

  describe('interaction', () => {
    it('calls onChangeValue with the negated value and fires haptics on click', () => {
      const onChangeValue = jest.fn();
      render(<Toggle data-testid="toggle" value={false} onChangeValue={onChangeValue} />);

      fireEvent.click(getToggle());

      expect(hapticMedium).toHaveBeenCalledTimes(1);
      expect(onChangeValue).toHaveBeenCalledTimes(1);
      expect(onChangeValue).toHaveBeenCalledWith(true);
    });

    it('negates a true value to false on click', () => {
      const onChangeValue = jest.fn();
      render(<Toggle data-testid="toggle" value onChangeValue={onChangeValue} />);

      fireEvent.click(getToggle());

      expect(onChangeValue).toHaveBeenCalledWith(false);
    });

    it('does nothing when disabled (no haptics, no callback)', () => {
      const onChangeValue = jest.fn();
      render(<Toggle data-testid="toggle" disabled onChangeValue={onChangeValue} />);

      fireEvent.click(getToggle());

      expect(hapticMedium).not.toHaveBeenCalled();
      expect(onChangeValue).not.toHaveBeenCalled();
    });

    it('does not throw and skips haptics when onChangeValue is omitted', () => {
      render(<Toggle data-testid="toggle" value={false} />);

      expect(() => fireEvent.click(getToggle())).not.toThrow();
      expect(hapticMedium).not.toHaveBeenCalled();
    });
  });

  describe('motion config across platforms', () => {
    it('enables layout animation and a spring transition on non-extension platforms', () => {
      mockIsExtension = false;
      render(<Toggle data-testid="toggle" />);

      const thumb = getThumb();
      expect(thumb).toHaveAttribute('data-layout', 'true');
      expect(JSON.parse(thumb.getAttribute('data-transition') as string)).toEqual({
        type: 'spring',
        stiffness: 700,
        damping: 30,
        backgroundColor: { duration: 0.2 }
      });
    });

    it('disables layout animation and uses a zero-duration transition on the extension', () => {
      mockIsExtension = true;
      render(<Toggle data-testid="toggle" />);

      const thumb = getThumb();
      expect(thumb).toHaveAttribute('data-layout', 'false');
      expect(JSON.parse(thumb.getAttribute('data-transition') as string)).toEqual({
        duration: 0
      });
    });
  });
});
