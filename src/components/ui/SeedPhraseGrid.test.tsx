import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SeedPhraseGrid, SeedPhrasePlaceholder, SeedPhrasePrivacyHero, SeedRevealToggle } from './SeedPhraseGrid';

let mockIsMobile = false;
jest.mock('lib/platform', () => ({ isMobile: () => mockIsMobile, isDesktop: () => false }));

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const WORDS = ['alpha', 'beta', 'gamma', 'delta'];

it('numbers the words on the group fill, in the phrase own casing', () => {
  render(<SeedPhraseGrid words={WORDS} data-testid="grid" />);

  const grid = screen.getByTestId('grid');
  expect(grid).toHaveClass('rounded-2xl', 'bg-fill');
  expect(screen.getByTestId('seed-word-0')).toHaveTextContent('alpha');
  expect(screen.getByTestId('seed-word-3')).toHaveTextContent('delta');
  expect(grid).toHaveTextContent('1.');
  expect(grid).toHaveTextContent('4.');
});

it('draws twelve blank bars for the placeholder, hidden from assistive tech', () => {
  const { container } = render(<SeedPhrasePlaceholder />);

  const card = container.firstElementChild!;
  expect(card).toHaveAttribute('aria-hidden', 'true');
  expect(card).toHaveClass('rounded-2xl', 'bg-fill');
  expect(card.querySelectorAll('.bg-fill-pressed')).toHaveLength(12);
  // The placeholder shows no words at all.
  expect(card.textContent).toBe('');
  expect(card.querySelector('[data-testid^="seed-word-"]')).toBeNull();
});

it('names the privacy warning both screens open on', () => {
  render(<SeedPhrasePrivacyHero />);
  expect(screen.getByText('viewThisInPrivatePlace')).toBeInTheDocument();
  expect(screen.getByText('anyoneWithRecoveryPhrase')).toBeInTheDocument();
});

it('masked renders no word text and no seed-word test ids', () => {
  const words = Array.from({ length: 12 }, (_, i) => `word${i}`);
  const { container } = render(<SeedPhraseGrid words={words} masked data-testid="grid" />);

  expect(screen.queryByText('word0')).toBeNull();
  expect(screen.queryByTestId('seed-word-0')).toBeNull();
  expect(container.textContent).not.toContain('word');
  expect(screen.getByRole('group', { name: 'recoveryPhraseHidden' })).toBeInTheDocument();
  expect(screen.getByTestId('grid')).toHaveAttribute('data-masked', 'true');
  expect(screen.getByText('12.')).toBeInTheDocument();
  expect(container.querySelectorAll('[aria-hidden="true"] > .bg-fill-pressed')).toHaveLength(12);
});

describe('SeedRevealToggle', () => {
  beforeEach(() => {
    mockIsMobile = false;
  });

  it('flips its label and pressed state with `revealed`', () => {
    const { rerender } = render(<SeedRevealToggle revealed={false} onToggle={jest.fn()} />);
    const toggle = screen.getByTestId('seed-reveal-toggle');
    expect(toggle).toHaveTextContent('show');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    rerender(<SeedRevealToggle revealed onToggle={jest.fn()} />);
    expect(toggle).toHaveTextContent('hide');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggle when pressed', () => {
    const onToggle = jest.fn();
    render(<SeedRevealToggle revealed={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('seed-reveal-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders nothing on mobile', () => {
    mockIsMobile = true;
    const { container } = render(<SeedRevealToggle revealed={false} onToggle={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// The words are not selectable (main.css), so a copy out of the grid has no secret to route: it stays the browser's.
it('leaves a copy out of the grid to the browser', () => {
  render(<SeedPhraseGrid words={WORDS} data-testid="grid" />);

  expect(fireEvent.copy(screen.getByTestId('grid'))).toBe(true);
});
