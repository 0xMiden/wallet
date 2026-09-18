import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { Button as LegacyPathButton, ButtonVariant as LegacyPathButtonVariant } from 'components/Button';
import { presets, springs } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';

import { Button, ButtonVariant } from './Button';

// Mock Loader component
jest.mock('components/Loader', () => ({
  Loader: ({ color }: { color: string }) => <span data-testid="loader" data-color={color} />
}));

// Mock haptics
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Surface the motion props the button passes to framer so the press preset is assertable.
let mockReduceMotion = false;
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  return {
    ...jest.requireActual('framer-motion'),
    useReducedMotion: () => mockReduceMotion,
    motion: {
      button: ReactActual.forwardRef(({ whileTap, transition, ...rest }: any, ref: any) => (
        <button
          ref={ref}
          data-while-tap={JSON.stringify(whileTap ?? null)}
          data-transition={JSON.stringify(transition ?? null)}
          {...rest}
        />
      ))
    }
  };
});

// Mock IconOrComponent
jest.mock('utils/icon-or-component', () => ({
  IconOrComponent: ({ icon, color }: any) => (
    <span data-testid="icon" data-color={color}>
      {icon}
    </span>
  )
}));

describe('Button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion = false;
  });

  it('renders button with default title', () => {
    render(<Button />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('Button Title')).toBeInTheDocument();
  });

  it('renders with custom title', () => {
    render(<Button title="Click Me" />);

    expect(screen.getByText('Click Me')).toBeInTheDocument();
  });

  it('renders children instead of title when provided', () => {
    render(<Button>Custom Content</Button>);

    expect(screen.getByText('Custom Content')).toBeInTheDocument();
    expect(screen.queryByText('Button Title')).not.toBeInTheDocument();
  });

  it('is still importable from components/Button', () => {
    expect(LegacyPathButton).toBe(Button);
    expect(LegacyPathButtonVariant).toBe(ButtonVariant);
  });

  describe('anatomy', () => {
    it('is a 52px full-width pill with the 19px extra-bold Nunito label by default', () => {
      render(<Button />);

      expect(screen.getByRole('button')).toHaveClass(
        'h-13',
        'rounded-full',
        'w-full',
        'font-heading',
        'text-[19px]',
        'font-extrabold'
      );
    });

    it('is a 36px pill with a 15px label at size sm', () => {
      render(<Button size="sm" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9', 'rounded-full', 'text-[15px]');
      expect(button).not.toHaveClass('h-13', 'w-full', 'text-[19px]');
    });

    it('lets className set layout on top of the size', () => {
      render(<Button className="w-auto mt-4" />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-auto', 'mt-4');
      expect(button).not.toHaveClass('w-full');
    });
  });

  describe('variants', () => {
    it('primary (default): accent fill, white label', () => {
      render(<Button />);

      expect(screen.getByRole('button')).toHaveClass('bg-accent-primary', 'text-text-on-accent');
    });

    it('secondary: fill, ink label', () => {
      render(<Button variant={ButtonVariant.Secondary} />);

      expect(screen.getByRole('button')).toHaveClass('bg-fill', 'text-ink');
    });

    it('destructive: fill, negative-ink label', () => {
      render(<Button variant={ButtonVariant.Destructive} />);

      expect(screen.getByRole('button')).toHaveClass('bg-fill', 'text-negative-ink');
    });

    it('ghost: no fill, hairline edge, ink label', () => {
      render(<Button variant={ButtonVariant.Ghost} />);

      expect(screen.getByRole('button')).toHaveClass('bg-transparent', 'border-hairline', 'text-ink');
    });

    it('colors icons from the label color', () => {
      render(<Button iconLeft="left" />);

      expect(screen.getByTestId('icon')).toHaveAttribute('data-color', 'currentColor');
    });
  });

  describe('haptic feedback', () => {
    it('triggers light haptic on click', () => {
      render(<Button variant={ButtonVariant.Primary} />);

      fireEvent.click(screen.getByRole('button'));

      expect(hapticLight).toHaveBeenCalled();
    });
  });

  it('calls onClick handler when clicked', () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe('disabled state', () => {
    it('uses the disabled accent fill for primary', () => {
      render(<Button disabled />);

      expect(screen.getByRole('button')).toBeDisabled();
      expect(screen.getByRole('button')).toHaveClass(
        'disabled:bg-primary-disabled',
        'dark:disabled:bg-primary-disabled-dark',
        'text-text-on-accent'
      );
    });

    it('does not call onClick when disabled', () => {
      const onClick = jest.fn();
      render(<Button disabled onClick={onClick} />);

      fireEvent.click(screen.getByRole('button'));

      expect(onClick).not.toHaveBeenCalled();
      expect(screen.getByRole('button')).toBeDisabled();
    });
  });

  describe('loading state', () => {
    it('swaps the label for the spinner and keeps the label in place to hold the width', () => {
      render(<Button isLoading title="Send" />);

      expect(screen.getByTestId('loader')).toBeInTheDocument();
      const label = screen.getByText('Send');
      expect(label.closest('[aria-hidden="true"]')).toHaveClass('invisible');
      expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    });

    it('holds the width for children content too', () => {
      render(
        <Button isLoading>
          <span>Custom</span>
        </Button>
      );

      expect(screen.getByTestId('loader')).toBeInTheDocument();
      expect(screen.getByText('Custom').closest('[aria-hidden="true"]')).toHaveClass('invisible');
    });

    it('disables pointer events when loading', () => {
      render(<Button isLoading />);

      expect(screen.getByRole('button')).toHaveClass('pointer-events-none');
    });

    it('shows no spinner when not loading', () => {
      render(<Button />);

      expect(screen.queryByTestId('loader')).not.toBeInTheDocument();
      expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
    });
  });

  describe('icons', () => {
    it('renders left icon', () => {
      render(<Button iconLeft="left-icon" />);

      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('renders right icon', () => {
      render(<Button iconRight="right-icon" />);

      expect(screen.getByTestId('icon')).toBeInTheDocument();
    });

    it('renders both icons', () => {
      render(<Button iconLeft="left" iconRight="right" />);

      expect(screen.getAllByTestId('icon')).toHaveLength(2);
    });
  });

  describe('press motion', () => {
    const motionProp = (name: 'while-tap' | 'transition') =>
      JSON.parse(screen.getByRole('button').getAttribute(`data-${name}`) as string);

    it('uses the press preset', () => {
      render(<Button />);

      expect(motionProp('while-tap')).toEqual(presets.press.whileTap);
      expect(motionProp('transition')).toEqual(springs.snappy);
    });

    it('presses instantly under reduced motion', () => {
      mockReduceMotion = true;
      render(<Button />);

      expect(motionProp('while-tap')).toEqual(presets.press.whileTap);
      expect(motionProp('transition')).toEqual({ duration: 0.001 });
    });

    it.each([
      ['disabled', { disabled: true }],
      ['loading', { isLoading: true }]
    ])('does not press while %s', (_state, props) => {
      render(<Button {...props} />);

      expect(motionProp('while-tap')).toBeNull();
    });
  });

  it('forwards data-testid to the root button', () => {
    render(<Button data-testid="cta" />);

    expect(screen.getByTestId('cta')).toBe(screen.getByRole('button'));
  });

  it('has button type by default', () => {
    render(<Button />);

    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
