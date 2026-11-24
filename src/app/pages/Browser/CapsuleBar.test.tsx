import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { CapsuleBar } from './CapsuleBar';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { ArrowDown: 'ArrowDown', Refresh: 'Refresh', Close: 'Close', More: 'More' }
}));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: (...args: unknown[]) => mockHapticLight(...args) }));

const mockPrepareMorph = jest.fn();
jest.mock('lib/dapp-browser/morph-boost', () => ({ prepareMorph: () => mockPrepareMorph() }));

jest.mock('lib/dapp-browser', () => ({
  getDappDisplayName: (session: { title?: string; origin: string }) => session.title ?? session.origin,
  getDappHostname: (url: string) => new URL(url).hostname,
  getFallbackColor: () => '#123456',
  getFallbackLetter: () => 'E',
  getFaviconUrl: () => undefined
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stand-in for the mocked module's DappSession
const SESSION: any = { id: 's1', url: 'https://example.dapp/app', origin: 'https://example.dapp', title: 'Example' };

const renderBar = (props: Partial<React.ComponentProps<typeof CapsuleBar>> = {}) => {
  const callbacks = {
    onClose: jest.fn(),
    onReload: jest.fn(),
    onMinimize: jest.fn(),
    onOpenSwitcher: jest.fn(),
    onOpenActions: jest.fn()
  };
  render(<CapsuleBar session={SESSION} tabsCount={2} {...callbacks} {...props} />);
  return callbacks;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CapsuleBar', () => {
  it('draws no drag strip: the header holds only the 56px content row and its bottom hairline', () => {
    renderBar();

    const header = screen.getByTestId('dapp-capsule');
    expect(header.querySelector('[data-drag-handle]')).toBeNull();
    expect(header.querySelector('[aria-roledescription]')).toBeNull();
    expect(screen.queryByLabelText('dragToMinimize')).toBeNull();
    expect(Array.from(header.children).map(child => child.className)).toEqual([
      'flex h-14 items-center gap-3 px-4',
      'h-px w-full bg-border-light'
    ]);
  });

  it('parks the dApp from the Minimize button with a tap haptic', () => {
    const { onMinimize } = renderBar();

    fireEvent.click(screen.getByTestId('dapp-capsule-minimize'));

    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });

  it('starts the minimize before its haptic', () => {
    const { onMinimize } = renderBar();

    fireEvent.click(screen.getByTestId('dapp-capsule-minimize'));

    expect(onMinimize.mock.invocationCallOrder[0]).toBeLessThan(mockHapticLight.mock.invocationCallOrder.at(-1)!);
  });

  it('raises the frame rate when a finger lands on Minimize, before the tap parks', () => {
    const { onMinimize } = renderBar();

    fireEvent.pointerDown(screen.getByTestId('dapp-capsule-minimize'));

    expect(mockPrepareMorph).toHaveBeenCalledTimes(1);
    expect(onMinimize).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByLabelText('reload'));
    expect(mockPrepareMorph).toHaveBeenCalledTimes(1);
  });

  it('draws no Minimize button when the caller cannot park', () => {
    renderBar({ onMinimize: undefined });

    expect(screen.queryByTestId('dapp-capsule-minimize')).toBeNull();
  });

  it('keeps Reload, Close, the tabs badge and the actions button, in that order after Minimize', () => {
    const { onReload, onClose, onOpenSwitcher, onOpenActions } = renderBar();

    const buttons = screen.getAllByRole('button').map(button => button.getAttribute('data-testid'));
    expect(buttons).toEqual([
      'dapp-capsule-minimize',
      'dapp-capsule-reload',
      'dapp-capsule-close',
      'dapp-capsule-switcher',
      'dapp-capsule-actions'
    ]);
    expect(screen.getByTestId('dapp-capsule-switcher').textContent).toBe('2');

    fireEvent.click(screen.getByTestId('dapp-capsule-reload'));
    fireEvent.click(screen.getByTestId('dapp-capsule-close'));
    fireEvent.click(screen.getByTestId('dapp-capsule-switcher'));
    fireEvent.click(screen.getByTestId('dapp-capsule-actions'));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(mockHapticLight).toHaveBeenCalledTimes(4);
  });

  it('forwards its ref to the header', () => {
    const ref = React.createRef<HTMLElement>();
    render(<CapsuleBar ref={ref} session={SESSION} onClose={jest.fn()} onReload={jest.fn()} />);

    expect(ref.current).toBe(screen.getByTestId('dapp-capsule'));
  });

  it('hides the tabs badge while only one dApp is open', () => {
    renderBar({ tabsCount: 1 });

    expect(screen.queryByTestId('dapp-capsule-switcher')).toBeNull();
  });
});
