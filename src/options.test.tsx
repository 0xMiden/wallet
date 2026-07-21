/**
 * src/options.tsx — the extension "Options" page entry point.
 *
 * The module has no exports: at import time it grabs `#root`, calls
 * `createRoot(...).render(<OptionsWrapper/>)`, and wires a single "Reset
 * extension" button whose click drives the module-scoped `handleReset`
 * state-machine. So the *entire* testable surface is reached by (a) importing
 * the module with a real `#root` present so the real `createRoot` mounts the
 * tree, and (b) clicking the rendered button under different mock behaviours to
 * exercise every branch of `handleReset` plus the `ResetExtensionConfirmation`
 * child.
 *
 * We keep the REAL `react-dom/client` so `OptionsWrapper` / `Options` actually
 * render (covering their JSX), and replace only the heavy leaf deps.
 */

import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import browser from 'webextension-polyfill';

// ---------------------------------------------------------------------------
// Dialog hooks — stable jest.fn identities captured once at render; their
// behaviour is reconfigured per test via mockResolvedValue / mockImplementation.
// (Names are `mock`-prefixed so the swc jest transform allows referencing them
//  from the hoisted `jest.mock` factory — same pattern as App.test.tsx.)
// ---------------------------------------------------------------------------
const mockConfirm = jest.fn();
const mockAlert = jest.fn();
const mockResetStorage = jest.fn();

// Side-effect-only / leaf imports: no-op them so no CSS parsing, lock-up checks,
// or heavy child providers run.
jest.mock('./main.css', () => ({}));
jest.mock('lib/lock-up/run-checks', () => ({}));

jest.mock('app/a11y/DisableOutlinesForClick', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('app/layouts/Dialogs', () => ({
  __esModule: true,
  default: () => <div data-testid="dialogs" />
}));

// getMessage(key) -> key, so button/heading text and dialog titles are the raw keys.
jest.mock('lib/i18n', () => ({
  getMessage: (key: string) => key
}));

jest.mock('lib/miden/reset', () => ({
  resetStorageDestructive: (...args: unknown[]) => mockResetStorage(...args)
}));

jest.mock('lib/ui/dialog', () => ({
  DialogsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAlert: () => mockAlert,
  useConfirm: () => mockConfirm
}));

// react-i18next drives the `ResetExtensionConfirmation` child.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const reloadMock = browser.runtime.reload as jest.Mock;

/**
 * Import `options.tsx` once, with `#root` present, inside `act` so the real
 * `createRoot(...).render(...)` flushes synchronously.
 */
beforeAll(async () => {
  const rootEl = document.createElement('div');
  rootEl.id = 'root';
  document.body.appendChild(rootEl);

  await act(async () => {
    require('./options');
  });
});

beforeEach(() => {
  mockConfirm.mockReset();
  mockAlert.mockReset();
  mockResetStorage.mockReset();
  reloadMock.mockClear();
});

const getResetButton = () => screen.getByRole('button', { name: 'resetExtension' });

describe('src/options.tsx', () => {
  it('mounts the Options page into #root with heading + reset button', () => {
    // OptionsWrapper -> Options JSX executed by the real createRoot render.
    expect(screen.getByRole('heading', { name: 'leoWalletOptions' })).toBeInTheDocument();
    expect(getResetButton()).toBeInTheDocument();
    // Dialogs child (mocked) is mounted alongside Options.
    expect(screen.getByTestId('dialogs')).toBeInTheDocument();
  });

  it('does nothing destructive when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);

    await act(async () => {
      fireEvent.click(getResetButton());
    });

    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'actionConfirmation' }));
    // Give any (non-)scheduled follow-up work a chance to run.
    await Promise.resolve();
    expect(mockResetStorage).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('resets storage and reloads the runtime when confirmed', async () => {
    mockConfirm.mockResolvedValue(true);
    mockResetStorage.mockResolvedValue(undefined);

    await act(async () => {
      fireEvent.click(getResetButton());
    });

    await waitFor(() => expect(mockResetStorage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('surfaces an alert with the error message when reset throws', async () => {
    mockConfirm.mockResolvedValue(true);
    mockResetStorage.mockRejectedValue(new Error('boom'));

    await act(async () => {
      fireEvent.click(getResetButton());
    });

    await waitFor(() => expect(mockAlert).toHaveBeenCalledTimes(1));
    expect(mockAlert).toHaveBeenCalledWith({ title: 'error', children: 'boom' });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('is re-entrancy guarded: a second click while confirm is pending is ignored', async () => {
    let resolveConfirm!: (value: boolean) => void;
    mockConfirm.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          resolveConfirm = resolve;
        })
    );

    // First click enters handleReset (resetting = true) and awaits confirm.
    await act(async () => {
      fireEvent.click(getResetButton());
    });
    // Second click while the first confirm is still pending hits `if (resetting) return`.
    await act(async () => {
      fireEvent.click(getResetButton());
    });

    expect(mockConfirm).toHaveBeenCalledTimes(1);

    // Release the guard so module state returns to `resetting = false`.
    await act(async () => {
      resolveConfirm(false);
      await Promise.resolve();
    });

    expect(mockResetStorage).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('renders ResetExtensionConfirmation (the confirm dialog body)', async () => {
    mockConfirm.mockResolvedValue(false);

    await act(async () => {
      fireEvent.click(getResetButton());
    });

    // The `children` passed to confirm is `<ResetExtensionConfirmation/>`; render
    // it directly to execute its `useTranslation` body.
    const { children } = mockConfirm.mock.calls[0][0] as { children: React.ReactElement };
    const { getByText } = render(children);
    expect(getByText('resetExtensionConfirmation')).toBeInTheDocument();
  });

  it('installs the Buffer polyfill when globalThis.Buffer is absent', () => {
    // Exercise the right-hand side of `globalThis.Buffer || Buffer` by
    // re-evaluating the module in an isolated registry with Buffer unset.
    const saved = (globalThis as unknown as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as unknown as { Buffer?: unknown }).Buffer;
      act(() => {
        jest.isolateModules(() => {
          require('./options');
        });
      });
      expect((globalThis as unknown as { Buffer?: unknown }).Buffer).toBeDefined();
    } finally {
      (globalThis as unknown as { Buffer?: unknown }).Buffer = saved;
    }
  });
});
