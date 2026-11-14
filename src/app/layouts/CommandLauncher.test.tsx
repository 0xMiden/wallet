import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { openCommandHome, WindowType } from 'app/env';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import CommandLauncher from './CommandLauncher';

const mockEnv = { popup: true, sidePanel: false, confirmWindow: false };
let mockExtension = true;
jest.mock('app/env', () => ({
  WindowType: { Popup: 0, FullPage: 1, SidePanel: 2 },
  useAppEnv: () => mockEnv,
  openCommandHome: jest.fn()
}));
jest.mock('lib/platform', () => ({
  isExtension: () => mockExtension,
  isMobile: () => false,
  isIOS: () => false,
  isAndroid: () => false,
  isDesktop: () => false
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

const mockOpen = openCommandHome as jest.MockedFunction<typeof openCommandHome>;

beforeEach(() => {
  jest.clearAllMocks();
  mockEnv.popup = true;
  mockEnv.sidePanel = false;
  mockEnv.confirmWindow = false;
  mockExtension = true;
});

it.each([
  ['popup', true, false, WindowType.Popup],
  ['side panel', false, true, WindowType.SidePanel]
] as const)('shows a full-width named launcher in the %s', (_surface, popup, sidePanel, source) => {
  mockEnv.popup = popup;
  mockEnv.sidePanel = sidePanel;
  mockOpen.mockResolvedValueOnce();
  render(<CommandLauncher />);
  const button = screen.getByRole('button', { name: 'commandOpenFullscreen' });
  expect(button).toHaveClass('h-12', 'w-full', 'bg-launcher-fill', 'text-launcher-ink');
  expect(button).not.toHaveClass('max-w-92.5');
  expect(button).toHaveAccessibleDescription('commandFullscreenNewTab');
  fireEvent.click(button);
  expect(mockOpen).toHaveBeenCalledWith(source);
});

it.each(['native', 'full page', 'confirmation'] as const)('does not offer a launcher in %s', surface => {
  mockExtension = surface !== 'native';
  mockEnv.popup = surface !== 'full page';
  mockEnv.confirmWindow = surface === 'confirmation';
  render(<CommandLauncher />);
  expect(screen.queryByRole('button', { name: 'commandOpenFullscreen' })).toBeNull();
});

it('keeps the compact surface usable after failure and permits retry', async () => {
  mockOpen.mockRejectedValueOnce(new Error('tabs unavailable')).mockResolvedValueOnce();
  render(<CommandLauncher />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'commandOpenFullscreen' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('commandFullscreenOpenFailed');
  expect(screen.getByRole('button', { name: 'commandOpenFullscreen' })).toBeEnabled();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'commandOpenFullscreen' }));
  });
  expect(mockOpen).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reports a visible tab creation failure on the inline surface without exposing the underlying error', async () => {
  jest.useFakeTimers();
  mockOpen.mockRejectedValueOnce(new Error('private draft and URL must not escape'));
  try {
    render(<CommandLauncher />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'commandOpenFullscreen' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('commandFullscreenOpenFailed');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private draft');
    act(() => jest.advanceTimersByTime(1000));
    expect(reportUserVisibleError).toHaveBeenCalledWith('commandFullscreenOpenFailed', 'inline');
  } finally {
    jest.useRealTimers();
  }
});

it('creates only one tab under duplicate activation while creation is pending', async () => {
  let finish: () => void = () => {};
  mockOpen.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)));
  render(<CommandLauncher />);
  const button = screen.getByRole('button', { name: 'commandOpenFullscreen' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(mockOpen).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});
