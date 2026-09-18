import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { PageHeader } from './PageHeader';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} />,
  IconName: { BackArrow: 'back-arrow', Close: 'close' }
}));

it('puts back, title, actions and close in one 52px row', () => {
  const onBack = jest.fn();
  const onClose = jest.fn();
  render(<PageHeader title="Address Book" onBack={onBack} onClose={onClose} actions={<span>edit</span>} />);

  const header = screen.getByRole('banner');
  expect(header).toHaveClass('h-13');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Address Book');
  expect(header).toHaveTextContent('edit');

  expect(screen.getByTestId('page-back')).not.toHaveClass('bg-surface-nav-button');
  expect(screen.getByTestId('page-back')).toHaveClass('h-11', 'w-11');

  fireEvent.click(screen.getByTestId('page-back'));
  fireEvent.click(screen.getByTestId('page-close'));
  expect(onBack).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('renders no heading without a title', () => {
  render(<PageHeader onBack={jest.fn()} />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
});

it('focuses the title on mount when asked, so the new page is announced', () => {
  render(<PageHeader title="Language" focusTitleOnMount />);
  expect(document.activeElement).toBe(screen.getByRole('heading'));
});
