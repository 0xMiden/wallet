import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

import FullScreenPage from './FullScreenPage';

const mockMotion = { reduce: false };

jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  return { ...actual, useReducedMotion: () => mockMotion.reduce };
});

afterEach(() => {
  mockMotion.reduce = false;
});

it('shows the page and releases the navbar when the page unmounts', () => {
  const { unmount } = render(
    <FullScreenPage>
      <span>Page content</span>
    </FullScreenPage>
  );

  expect(screen.getByText('Page content')).toBeInTheDocument();
  expect(document.body).toHaveAttribute('data-hide-navbar');
  unmount();
  expect(document.body).not.toHaveAttribute('data-hide-navbar');
});

it('brings a slide page in from the right without vertical movement', async () => {
  const { container } = render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  const page = container.firstElementChild;
  expect(page).toHaveStyle({ transform: 'translateX(100%)', opacity: '1' });
  await waitFor(() => expect(page).toHaveStyle({ transform: 'none' }));
});

it('shows a slide page immediately when reduced motion is enabled', () => {
  mockMotion.reduce = true;
  const { container } = render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  expect(container.firstElementChild).toHaveStyle({ opacity: '1' });
  expect(container.firstElementChild).not.toHaveStyle({ transform: 'translateX(100%)' });
});
