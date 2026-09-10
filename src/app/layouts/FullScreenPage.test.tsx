import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

import FullScreenPage from './FullScreenPage';

const mockPlatform = { mobile: false, reduce: false };

jest.mock('lib/platform', () => ({ isMobile: () => mockPlatform.mobile }));
jest.mock('framer-motion', () => {
  const actual = jest.requireActual<typeof import('framer-motion')>('framer-motion');
  return { ...actual, useReducedMotion: () => mockPlatform.reduce };
});

afterEach(() => {
  mockPlatform.mobile = false;
  mockPlatform.reduce = false;
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

it('brings the mobile Settings page in from the right without vertical movement', async () => {
  mockPlatform.mobile = true;
  const { container } = render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  const page = container.firstElementChild;
  expect(page).toHaveStyle({ transform: 'translateX(100%)', opacity: '1' });
  await waitFor(() => expect(page).toHaveStyle({ transform: 'none' }));
});

it('shows Settings immediately when reduced motion is enabled', () => {
  mockPlatform.mobile = true;
  mockPlatform.reduce = true;
  const { container } = render(<FullScreenPage entrance="slide">Settings</FullScreenPage>);
  expect(container.firstElementChild).toHaveStyle({ opacity: '1' });
  expect(container.firstElementChild).not.toHaveStyle({ transform: 'translateX(100%)' });
});
