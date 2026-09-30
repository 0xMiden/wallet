import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { BAKE_PHASE_MS } from 'lib/animation';
import { hapticSuccess } from 'lib/mobile/haptics';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';

import { MainnetWelcome } from './MainnetWelcome';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSuccess: jest.fn(), hapticLight: jest.fn() }));

jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({ useHideNavbarWhileOpen: jest.fn() }));

// The back press as the screen registers it: the test calls the handler directly.
let mockBackHandler: (() => boolean | void) | undefined;
let mockBackOptions: { overlay?: boolean } | undefined;
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void, _deps: unknown[], options?: { overlay?: boolean }) => {
    mockBackHandler = handler;
    mockBackOptions = options;
  }
}));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'devnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

// Only the reduced-motion preference is replaced. The real motion elements render.
let mockReduce = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

const screenEl = () => screen.getByTestId('mainnet-welcome');
const phase = () => screenEl().getAttribute('data-phase');
const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
const SEQUENCE_MS = Object.values(BAKE_PHASE_MS).reduce((sum, ms) => sum + ms, 0);
// Each phase sets the timer of the subsequent one in an effect, after its own render. So the clock
// moves one phase at a time, with a render between two steps.
const runSequence = () => Object.values(BAKE_PHASE_MS).forEach(advance);

describe('MainnetWelcome', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReduce = false;
    mockNetworkKey = 'devnet';
    mockBackHandler = undefined;
    jest.mocked(hapticSuccess).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('renders nothing while it is closed', () => {
    render(<MainnetWelcome open={false} onContinue={jest.fn()} />);

    expect(screen.queryByTestId('mainnet-welcome')).not.toBeInTheDocument();
  });

  it('opens as a dialog named by its title, over the tab bar, on the first phase', () => {
    render(<MainnetWelcome open onContinue={jest.fn()} />);

    expect(screenEl()).toHaveAttribute('role', 'dialog');
    expect(screenEl()).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog', { name: 'mainnetWelcomeTitle' })).toBe(screenEl());
    expect(phase()).toBe('enter');
    expect(useHideNavbarWhileOpen).toHaveBeenCalledWith(true);
  });

  it('labels the dough with the effective test network and the loaf with mainnet', () => {
    render(<MainnetWelcome open onContinue={jest.fn()} />);

    expect(screen.getByTestId('oven-scene-dough-label')).toHaveTextContent('devnet');
    expect(screen.getByTestId('oven-scene-loaf-label')).toHaveTextContent('mainnet');
  });

  it('moves through the phases on their timers and stops on the welcome', () => {
    render(<MainnetWelcome open onContinue={jest.fn()} />);

    advance(BAKE_PHASE_MS.enter);
    expect(phase()).toBe('open');
    expect(screen.getByTestId('oven-scene-door')).toHaveAttribute('data-open', 'true');

    advance(BAKE_PHASE_MS.open);
    advance(BAKE_PHASE_MS.load);
    advance(BAKE_PHASE_MS.close);
    expect(phase()).toBe('bake');
    expect(screen.getByTestId('oven-scene-door')).toHaveAttribute('data-open', 'false');

    advance(BAKE_PHASE_MS.bake);
    advance(BAKE_PHASE_MS.ding);
    expect(phase()).toBe('serve');

    advance(BAKE_PHASE_MS.serve);
    expect(phase()).toBe('welcome');

    // The welcome has no timer: it stays.
    advance(SEQUENCE_MS);
    expect(phase()).toBe('welcome');
  });

  it('fires one success haptic, when the loaf comes out', () => {
    render(<MainnetWelcome open onContinue={jest.fn()} />);
    expect(hapticSuccess).not.toHaveBeenCalled();

    runSequence();

    expect(hapticSuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps Continue disabled during the sequence, then enables it and gives it focus', () => {
    const onContinue = jest.fn();
    render(<MainnetWelcome open onContinue={onContinue} />);
    const button = screen.getByTestId('mainnet-welcome-continue');
    expect(button).toBeDisabled();

    runSequence();

    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('skips to the welcome on a tap anywhere, and then has no skip control', () => {
    render(<MainnetWelcome open onContinue={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'skip' }));

    expect(phase()).toBe('welcome');
    expect(screen.queryByTestId('mainnet-welcome-skip')).not.toBeInTheDocument();
  });

  it('skips on Escape during the sequence, and continues on Escape from the welcome', () => {
    const onContinue = jest.fn();
    render(<MainnetWelcome open onContinue={onContinue} />);

    fireEvent.keyDown(screenEl(), { key: 'Escape' });
    expect(phase()).toBe('welcome');
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.keyDown(screenEl(), { key: 'Escape' });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('takes the mobile back press as an overlay, with the same two steps', () => {
    const onContinue = jest.fn();
    render(<MainnetWelcome open onContinue={onContinue} />);
    expect(mockBackOptions).toEqual({ overlay: true });

    let consumed: boolean | void;
    act(() => {
      consumed = mockBackHandler?.();
    });
    expect(consumed!).toBe(true);
    expect(phase()).toBe('welcome');

    act(() => {
      mockBackHandler?.();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('opens on the welcome under reduced motion, with no sequence and no haptic', () => {
    mockReduce = true;
    render(<MainnetWelcome open onContinue={jest.fn()} />);

    expect(phase()).toBe('welcome');
    expect(screen.getByTestId('mainnet-welcome-continue')).toBeEnabled();
    expect(screen.queryByTestId('mainnet-welcome-skip')).not.toBeInTheDocument();
    expect(hapticSuccess).not.toHaveBeenCalled();
  });

  it('starts the sequence again each time it opens', () => {
    const { rerender } = render(<MainnetWelcome open onContinue={jest.fn()} />);
    runSequence();
    expect(phase()).toBe('welcome');

    rerender(<MainnetWelcome open={false} onContinue={jest.fn()} />);
    rerender(<MainnetWelcome open onContinue={jest.fn()} />);

    expect(phase()).toBe('enter');
  });
});
