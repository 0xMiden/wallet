import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { DappSwitcher } from './DappSwitcher';

const mockSessionStates = [
  {
    session: { id: 'session-1', url: 'https://app.example/', origin: 'https://app.example', title: 'Example' },
    // Loading, so the card renders its loading badge as well as its close control.
    isLoading: true
  }
];

const mockRestore = jest.fn();

jest.mock('app/providers/DappBrowserProvider', () => ({
  useDappBrowser: () => ({ sessionStates: mockSessionStates, restore: mockRestore, close: jest.fn() })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/dapp-browser/snapshot-store', () => ({ getSnapshot: () => undefined }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));
const mockPrepareMorph = jest.fn();
jest.mock('lib/dapp-browser/morph-boost', () => ({ prepareMorph: () => mockPrepareMorph() }));

// motion.div as a plain div that reports its `layout` mode.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  return {
    ...jest.requireActual('framer-motion'),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    motion: {
      div: ReactActual.forwardRef(
        (
          {
            children,
            layout,
            initial,
            animate,
            exit,
            transition,
            ...rest
          }: Record<string, unknown> & { children?: React.ReactNode },
          ref: React.Ref<HTMLDivElement>
        ) => (
          <div ref={ref} data-layout={String(layout)} {...rest}>
            {children}
          </div>
        )
      )
    }
  };
});

describe('DappSwitcher', () => {
  // A bare `layout` would scale a card on any render that changed its size, drawing its corners, shadow
  // and contents stretched for the spring; the reflow when a card closes only needs to move it.
  it('animates each card by position only, so a resize never scales it', () => {
    render(<DappSwitcher open onClose={jest.fn()} />);

    // Exact value: bare `layout` stringifies to 'true', so a not-'position' check alone proves nothing.
    expect(screen.getByRole('listitem')).toHaveAttribute('data-layout', 'position');
  });

  // A restore while the switcher still blocks the host could never morph (#1817).
  it('closes first and restores on the next frame', () => {
    const frames: FrameRequestCallback[] = [];
    const frame = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback));
    const onClose = jest.fn();
    render(<DappSwitcher open onClose={onClose} />);

    fireEvent.click(screen.getByTestId('dapp-switcher-card'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockRestore).not.toHaveBeenCalled();
    frames.forEach(callback => callback(0));

    expect(mockRestore).toHaveBeenCalledWith('session-1');
    frame.mockRestore();
  });

  it('raises the frame rate when a finger lands on a card, before the tap restores it', () => {
    mockPrepareMorph.mockClear();
    mockRestore.mockClear();
    render(<DappSwitcher open onClose={jest.fn()} />);

    fireEvent.pointerDown(screen.getByTestId('dapp-switcher-card'));

    expect(mockPrepareMorph).toHaveBeenCalledTimes(1);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  // `black` is ink, white in dark theme, so a control dimmed with it would glow white on the snapshot.
  it('dims its card controls with pure black, never the theme black', () => {
    render(<DappSwitcher open onClose={jest.fn()} />);

    expect(screen.getByText('dappSwitcherLoading')).toBeInTheDocument();
    const themeBlack = [...document.body.querySelectorAll('[class]')].flatMap(el =>
      (el.getAttribute('class') ?? '').split(/\s+/).filter(cls => cls.startsWith('bg-black/'))
    );
    expect(themeBlack).toEqual([]);
  });
});
