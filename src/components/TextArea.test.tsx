import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { TextArea } from './TextArea';

// jsdom does not implement layout, so `scrollHeight` is always 0 unless we
// override the getter. We install a configurable getter on the prototype so
// the auto-resize effect (which reads scrollHeight) has a deterministic value
// to work with, then restore it after each test.
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

const setScrollHeight = (value: number) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return value;
    }
  });
};

const getTextArea = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('TextArea', () => {
  afterEach(() => {
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    } else {
      // jsdom's default scrollHeight is a non-configurable 0; if there was no
      // own descriptor to restore, fall back to a plain 0 getter.
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return 0;
        }
      });
    }
  });

  describe('rendering', () => {
    it('renders a textarea element', () => {
      render(<TextArea />);

      const el = getTextArea();
      expect(el).toBeInTheDocument();
      expect(el.tagName).toBe('TEXTAREA');
    });

    it('always applies the base style classes', () => {
      render(<TextArea />);

      const el = getTextArea();
      expect(el).toHaveClass(
        'border',
        'rounded-[10px]',
        'border-border-light',
        'transition-colors',
        'duration-150',
        'ease-hover',
        'min-h-[48px]',
        'p-3',
        'resize-none',
        'overflow-hidden',
        'bg-white',
        'text-black',
        'placeholder-grey-400',
        'font-base',
        'text-base',
        'hover:border-border-light',
        'outline-none',
        'focus:border-black',
        'focus:ring-1',
        'focus:ring-black',
        'active:border-black'
      );
    });

    it('merges a custom className onto the textarea', () => {
      render(<TextArea className="my-custom-class" />);

      const el = getTextArea();
      // Custom class is appended...
      expect(el).toHaveClass('my-custom-class');
      // ...without dropping the base classes.
      expect(el).toHaveClass('resize-none', 'overflow-hidden');
    });

    it('renders the base classes when className is omitted (falsy branch)', () => {
      render(<TextArea />);

      // clsx drops the trailing undefined className argument; the class list
      // should still contain the base classes and nothing stray.
      const el = getTextArea();
      expect(el.className).toContain('resize-none');
      expect(el.className).not.toContain('undefined');
    });
  });

  describe('props passthrough', () => {
    it('forwards the value prop', () => {
      render(<TextArea value="hello world" onChange={() => {}} />);

      expect(getTextArea()).toHaveValue('hello world');
    });

    it('forwards arbitrary attributes such as placeholder and id', () => {
      render(<TextArea placeholder="Type here" id="notes" />);

      const el = getTextArea();
      expect(el).toHaveAttribute('placeholder', 'Type here');
      expect(el).toHaveAttribute('id', 'notes');
    });

    it('forwards the disabled attribute', () => {
      render(<TextArea disabled />);

      expect(getTextArea()).toBeDisabled();
    });

    it('forwards data attributes and aria attributes', () => {
      render(<TextArea data-testid="my-textarea" aria-label="description field" />);

      const el = screen.getByTestId('my-textarea');
      expect(el).toHaveAttribute('aria-label', 'description field');
    });

    it('forwards event handlers such as onChange', () => {
      const onChange = jest.fn();
      render(<TextArea value="" onChange={onChange} />);

      fireEvent.change(getTextArea(), { target: { value: 'x' } });

      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('auto-resize effect', () => {
    it('sets the height to the measured scrollHeight on mount', () => {
      setScrollHeight(120);

      render(<TextArea value="line1\nline2\nline3" onChange={() => {}} />);

      // The effect resets height to 0px, reads scrollHeight (120), then pins
      // the height to that measured value.
      expect(getTextArea().style.height).toBe('120px');
    });

    it('sets the height to 0px when scrollHeight measures as 0', () => {
      setScrollHeight(0);

      render(<TextArea value="short" onChange={() => {}} />);

      expect(getTextArea().style.height).toBe('0px');
    });

    it('recomputes the height when the value prop changes', () => {
      setScrollHeight(48);

      const { rerender } = render(<TextArea value="a" onChange={() => {}} />);
      expect(getTextArea().style.height).toBe('48px');

      // A new value re-runs the effect; the freshly measured scrollHeight wins.
      setScrollHeight(96);
      rerender(<TextArea value="a much longer value" onChange={() => {}} />);

      expect(getTextArea().style.height).toBe('96px');
    });

    it('runs the resize effect even when no value is provided', () => {
      setScrollHeight(64);

      render(<TextArea />);

      // The ref is populated after mount, so the effect body executes and sets
      // the height from the measured scrollHeight.
      expect(getTextArea().style.height).toBe('64px');
    });
  });
});
