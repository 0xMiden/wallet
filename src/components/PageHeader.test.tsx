import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { PageHeader } from './PageHeader';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className, fill }: { name: string; size?: string; className?: string; fill?: string }) => (
    <svg data-testid={`icon-${name}`} data-size={size} data-fill={fill} className={className} />
  ),
  IconName: { ArrowLeft: 'arrow-left', ChevronLeft: 'chevron-left', Close: 'close' }
}));

it('puts back, title, actions and close in one 60px row', () => {
  const onBack = jest.fn();
  const onClose = jest.fn();
  render(<PageHeader title="Address Book" onBack={onBack} onClose={onClose} actions={<span>edit</span>} />);

  const header = screen.getByRole('banner');
  expect(header).toHaveClass('h-15');
  // The inset rule under the title, a sibling of the row so the row keeps its height.
  expect(header.nextElementSibling).toHaveClass('h-1', 'rounded-full', 'bg-fill');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Address Book');
  expect(header).toHaveTextContent('edit');

  expect(screen.getByTestId('page-back')).toHaveClass('bg-fill', 'rounded-full');
  expect(screen.getByTestId('page-back')).toHaveClass('h-11', 'w-11');

  fireEvent.click(screen.getByTestId('page-back'));
  fireEvent.click(screen.getByTestId('page-close'));
  expect(onBack).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('draws back as a 24px ink arrow on a fill circle and close as a 24px ink glyph', () => {
  render(<PageHeader title="New contact" onBack={jest.fn()} onClose={jest.fn()} />);

  // `ink` lives on the IconButton itself (a `bare` IconButton's default color); the glyph
  // inherits it through `fill="currentColor"`, the same pattern TabHeaderAction uses.
  const backButton = screen.getByTestId('page-back');
  expect(backButton).toHaveClass('text-ink');
  const back = screen.getByTestId('icon-arrow-left');
  expect(backButton).toContainElement(back);
  expect(back).toHaveAttribute('data-fill', 'currentColor');
  expect(back).toHaveAttribute('data-size', 'md');

  const closeButton = screen.getByTestId('page-close');
  expect(closeButton).toHaveClass('text-ink');
  const close = screen.getByTestId('icon-close');
  expect(close).toHaveAttribute('data-fill', 'currentColor');
  expect(close).toHaveAttribute('data-size', 'md');
});

it('renders no heading without a title', () => {
  render(<PageHeader onBack={jest.fn()} />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
});

it('focuses the title on mount when asked, so the new page is announced', () => {
  render(<PageHeader title="Language" focusTitleOnMount />);
  expect(document.activeElement).toBe(screen.getByRole('heading'));
});
