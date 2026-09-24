import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { presets } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';

import { Card, CardButton, type CardPadding, FOCUSABLE_CLASSES } from './Card';

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Surface the motion props the card button passes to framer so the press preset is assertable.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  return {
    ...jest.requireActual('framer-motion'),
    useReducedMotion: () => false,
    motion: {
      button: ReactActual.forwardRef(
        (
          { whileTap, transition, ...rest }: { whileTap?: unknown; transition?: unknown } & Record<string, unknown>,
          ref: React.Ref<HTMLButtonElement>
        ) => <button ref={ref} data-while-tap={JSON.stringify(whileTap ?? null)} {...rest} />
      )
    }
  };
});

const hasBorderClass = (el: HTMLElement) => el.className.split(/\s+/).some(c => /^border(-|$)/.test(c));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Card', () => {
  it('is a fill surface with 16px corners and no border', () => {
    render(
      <Card data-testid="card" className="mt-2">
        content
      </Card>
    );

    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveClass('bg-fill', 'rounded-2xl', 'mt-2');
    expect(hasBorderClass(card)).toBe(false);
  });

  const paddings: Array<[CardPadding, string[]]> = [
    ['tile', ['p-4']],
    ['row', ['px-4', 'py-3']],
    ['none', []]
  ];

  it.each(paddings)('pads the %s variant', (padding, classes) => {
    render(
      <Card data-testid="card" padding={padding}>
        content
      </Card>
    );

    const card = screen.getByTestId('card');
    expect(card).toHaveClass('bg-fill', ...classes);
  });

  it('adds no padding for the none variant', () => {
    render(
      <Card data-testid="card" padding="none">
        content
      </Card>
    );
    expect(screen.getByTestId('card').className).not.toMatch(/\bp[xy]?-\d/);
  });

  it('defaults to the tile padding', () => {
    render(<Card data-testid="card">content</Card>);
    expect(screen.getByTestId('card')).toHaveClass('p-4');
  });

  it('draws its surface onto the child with asChild', () => {
    render(
      <Card asChild padding="none" className="flex-col">
        <article data-testid="article" className="overflow-hidden">
          content
        </article>
      </Card>
    );

    const article = screen.getByTestId('article');
    expect(article.tagName).toBe('ARTICLE');
    expect(article).toHaveClass('bg-fill', 'rounded-2xl', 'overflow-hidden', 'flex-col');
    expect(hasBorderClass(article)).toBe(false);
  });

  it('adds pressed feedback when pressable, and no focus ring with it', () => {
    render(
      <Card data-testid="card" pressable>
        content
      </Card>
    );

    const card = screen.getByTestId('card');
    expect(card).toHaveClass('hover:bg-fill-pressed', 'active:bg-fill-pressed');
    // The ring is the other half: claiming it on a child that cannot take focus advertises
    // behaviour the card cannot deliver, and `select-none` would stop the text being selectable.
    expect(card.className).not.toContain('focus-visible:ring-2');
    expect(card.className).not.toContain('select-none');
  });

  it('has no pressed feedback by default', () => {
    render(<Card data-testid="card">content</Card>);
    expect(screen.getByTestId('card').className).not.toContain('active:bg-fill-pressed');
  });
});

describe('CardButton', () => {
  it('is a fill button with no border, pressed feedback and a focus ring', () => {
    render(
      <CardButton data-testid="card" padding="row" className="w-full">
        content
      </CardButton>
    );

    const button = screen.getByTestId('card');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass(
      'bg-fill',
      'rounded-2xl',
      'px-4',
      'py-3',
      'w-full',
      'active:bg-fill-pressed',
      'focus-visible:ring-2',
      'focus-visible:ring-accent-primary'
    );
    expect(hasBorderClass(button)).toBe(false);
  });

  // Enumerated on purpose, NOT derived from FOCUSABLE_CLASSES. An `it.each(FOCUSABLE_CLASSES)`
  // reads its cases from the very constant it checks, so deleting a line just removes a case and
  // the suite stays green - verified by mutation, which is how this assertion got written twice.
  // The expectation has to be independent of the thing it pins.
  it('gives CardButton every focusable class', () => {
    render(<CardButton onClick={jest.fn()}>go</CardButton>);

    const button = screen.getByRole('button');
    expect(button).toHaveClass(
      'select-none',
      'outline-none',
      'focus-visible:ring-2',
      'focus-visible:ring-accent-primary',
      'focus-visible:ring-offset-2',
      'focus-visible:ring-offset-page',
      // `disabled:` matches `:disabled`, so these are only real on the button. They used to be
      // claimed by a `Card` variant that renders a `div`, where they could never fire.
      'disabled:cursor-default',
      'disabled:opacity-50',
      'disabled:hover:bg-fill',
      'disabled:active:bg-fill'
    );
  });

  // The other half of the pin. Count CLASSES, not array entries: the constant groups several
  // classes per string, so a class appended inside an existing entry leaves the entry count
  // unchanged and would ship unpinned - which is what the first version of this guard missed.
  it('has no focusable class the assertion above does not name', () => {
    const classes = FOCUSABLE_CLASSES.flatMap(line => line.split(' ')).filter(Boolean);

    expect(classes).toHaveLength(10);
  });

  it('fires the tap haptic and then the handler', () => {
    const onClick = jest.fn();
    render(
      <CardButton data-testid="card" onClick={onClick}>
        content
      </CardButton>
    );

    fireEvent.click(screen.getByTestId('card'));
    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('carries the press preset while enabled and drops it when disabled', () => {
    const { rerender } = render(<CardButton data-testid="card">content</CardButton>);
    expect(screen.getByTestId('card')).toHaveAttribute('data-while-tap', JSON.stringify(presets.press.whileTap));

    rerender(
      <CardButton data-testid="card" disabled>
        content
      </CardButton>
    );
    expect(screen.getByTestId('card')).toBeDisabled();
    expect(screen.getByTestId('card')).toHaveAttribute('data-while-tap', 'null');
  });

  it('forwards aria and data attributes', () => {
    render(
      <CardButton data-testid="card" aria-label="Open app" data-dapp-url="https://example.org">
        content
      </CardButton>
    );

    const button = screen.getByRole('button', { name: 'Open app' });
    expect(button).toHaveAttribute('data-dapp-url', 'https://example.org');
  });
});

// @ts-expect-error The surface type stays inside Card.
type InternalSurface = import('./Card').CardSurface;

describe('Card surfaces', () => {
  it('fills by default and outlines on request', () => {
    const { container, rerender } = render(<Card>x</Card>);
    expect(container.firstChild).toHaveClass('bg-fill');

    rerender(<Card surface="outline">x</Card>);
    expect(container.firstChild).toHaveClass('bg-page', 'border', 'border-hairline', 'rounded-2xl');
    expect(container.firstChild).not.toHaveClass('bg-fill');
  });

  it('offers the outline on Card only: a CardButton is always the fill', () => {
    const surface: InternalSurface = 'outline';
    render(
      // @ts-expect-error CardButton takes no surface.
      <CardButton surface={surface} onClick={() => undefined}>
        x
      </CardButton>
    );
    expect(screen.getByRole('button')).toHaveClass('bg-fill');
    expect(screen.getByRole('button')).not.toHaveClass('bg-page');
  });
});
