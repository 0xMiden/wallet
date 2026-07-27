/**
 * RotateGuardian — the guardian-rotation picker page. It wraps
 * `ChooseGuardianScreen`, refuses a no-op switch (same endpoint as the current
 * one), and otherwise hands the chosen endpoint to the review route as a query
 * param. Every collaborator is stubbed so only this page's logic is exercised.
 */

import React from 'react';

import { act, render, screen } from '@testing-library/react';

import RotateGuardian from './RotateGuardian';

const mockUseCurrentGuardianEndpoint = jest.fn();
jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => mockUseCurrentGuardianEndpoint()
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/layouts/PageLayout', () => ({
  __esModule: true,
  default: ({ pageTitle, children }: { pageTitle?: React.ReactNode; children?: React.ReactNode }) => (
    <div data-testid="page-layout">
      <div data-testid="page-title">{pageTitle}</div>
      {children}
    </div>
  )
}));

// Captured so tests can drive `onSubmit` directly and assert the props the page
// hands down (current endpoint highlight + custom-endpoint affordance).
let chooseProps: { onSubmit?: (p: { guardianId: string; guardianEndpoint: string }) => void } & Record<
  string,
  unknown
> = {};
jest.mock('screens/onboarding/common/ChooseGuardian', () => ({
  ChooseGuardianScreen: (props: Record<string, unknown>) => {
    chooseProps = props;
    return <div data-testid="choose-guardian" />;
  }
}));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (arg: unknown) => mockNavigate(arg) }));

beforeEach(() => {
  jest.clearAllMocks();
  chooseProps = {};
  mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: 'https://current.guardian', refresh: jest.fn() });
});

it('passes the current endpoint down and allows a custom one', () => {
  render(<RotateGuardian />);

  expect(screen.getByTestId('choose-guardian')).toBeInTheDocument();
  expect(screen.getByTestId('page-title')).toHaveTextContent('rotateGuardian');
  expect(chooseProps.currentEndpoint).toBe('https://current.guardian');
  expect(chooseProps.allowCustomEndpoint).toBe(true);
});

it('navigates to the review route with the chosen endpoint encoded', () => {
  render(<RotateGuardian />);

  act(() => chooseProps.onSubmit?.({ guardianId: 'next', guardianEndpoint: 'https://next.guardian/x' }));

  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/rotate-guardian/review',
    search: `?endpoint=${encodeURIComponent('https://next.guardian/x')}`
  });
});

it('refuses a switch to the endpoint already in use', () => {
  render(<RotateGuardian />);

  act(() => chooseProps.onSubmit?.({ guardianId: 'same', guardianEndpoint: 'https://current.guardian' }));

  expect(mockNavigate).not.toHaveBeenCalled();
  expect(screen.getByText('guardianEndpointUnchanged')).toBeInTheDocument();
});

it('clears a stale unchanged-endpoint error once a different guardian is picked', () => {
  render(<RotateGuardian />);

  act(() => chooseProps.onSubmit?.({ guardianId: 'same', guardianEndpoint: 'https://current.guardian' }));
  expect(screen.getByText('guardianEndpointUnchanged')).toBeInTheDocument();

  act(() => chooseProps.onSubmit?.({ guardianId: 'next', guardianEndpoint: 'https://next.guardian' }));

  expect(screen.queryByText('guardianEndpointUnchanged')).not.toBeInTheDocument();
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});
