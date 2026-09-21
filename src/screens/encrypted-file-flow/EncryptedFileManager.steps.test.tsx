import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { EncryptedFileFlow } from './EncryptedFileManager';

/**
 * The DOM contract the Chrome E2E harness drives the export through
 * (`exportEncryptedWalletFile` in playwright/e2e/helpers/wallet-page.ts).
 *
 * Unlike the sibling suite, this one mounts the REAL Navigator and the REAL step pages, because
 * the contract is about how the steps sit inside the flow: each step is a page on the shared frame
 * now, so the flow's subtree holds whichever step is mounted rather than only the export one (the
 * wallet-password step used to be portalled out of it by a drawer). A harness that looks a field up
 * on the flow therefore has to be looking at the right step — which is only safe if each step is
 * addressable, only one is ever mounted, and each step's pinned CTA is inside that step's own page.
 * All three are asserted here.
 */

// ---------------------------------------------------------------------------
// Module mocks: every boundary outside the flow's own markup.
// ---------------------------------------------------------------------------
const mockUnlock = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('framer-motion', () => {
  const ReactLib = require('react');
  // One component per tag, cached: a fresh component type on every property read would make React
  // treat each render as a different element and remount the whole step, losing its state.
  const tags = new Map<string, unknown>();
  const MOTION_ONLY_PROPS = [
    'initial',
    'animate',
    'exit',
    'variants',
    'transition',
    'custom',
    'layout',
    'layoutRoot',
    'whileTap',
    'whileHover',
    'whileFocus'
  ];
  const passthrough = (tag: string) => {
    if (!tags.has(tag)) {
      tags.set(
        tag,
        ReactLib.forwardRef(({ children, ...props }: { children?: React.ReactNode }, ref: unknown) => {
          const domProps = Object.fromEntries(
            Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.includes(key))
          );
          return ReactLib.createElement(tag, { ...domProps, ref }, children);
        })
      );
    }
    return tags.get(tag);
  };
  return {
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, children),
    motion: new Proxy({}, { get: (_target: unknown, tag: string) => passthrough(tag) }),
    useReducedMotion: () => true
  };
});

jest.mock('lib/platform', () => ({
  isMobile: () => false,
  isIOS: () => false,
  isAndroid: () => false,
  isExtension: () => true
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: () => Promise.resolve(false) }
}));

jest.mock('lib/miden/front', () => {
  const ReactLib = require('react');
  return {
    useMidenContext: () => ({ unlock: mockUnlock }),
    useLocalStorage: (_key: string, initial: unknown) => ReactLib.useState(initial)
  };
});

jest.mock('screens/onboarding/common/CreatePassword', () => ({
  __esModule: true,
  PasswordStrengthIndicator: () => <div data-testid="password-strength" />
}));

// The third step encrypts and writes the file through Capacitor; it is past everything asserted
// here, and importing it for real would pull the whole export pipeline into this suite.
jest.mock('./ExportFileComplete', () => ({
  __esModule: true,
  default: () => <div data-testid="export-complete-step" />
}));

// A password that satisfies the export step's own strength rule: mixed case, a digit and a symbol.
const FILE_PASSWORD = 'Backup1234!';

const flowRoot = () => screen.getByTestId('encrypted-file-manager-flow');

const advanceToExportStep = async () => {
  const unlockStep = within(flowRoot()).getByTestId('encrypted-file-wallet-password');
  fireEvent.change(within(unlockStep).getByTestId('encrypted-file-wallet-password-input'), {
    target: { value: 'Test1234!' }
  });
  fireEvent.click(within(unlockStep).getByTestId('encrypted-file-wallet-password-consent'));
  await act(async () => {
    fireEvent.click(within(unlockStep).getByTestId('encrypted-file-wallet-password-submit'));
  });
  await waitFor(() => expect(screen.getByTestId('export-file-password')).toBeInTheDocument());
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUnlock.mockResolvedValue(undefined);
});

describe('EncryptedFileFlow step containment', () => {
  it('shows the wallet-password step, with its field, consent and pinned CTA, inside the flow root', async () => {
    render(<EncryptedFileFlow />);

    const unlockStep = await within(flowRoot()).findByTestId('encrypted-file-wallet-password');
    expect(within(unlockStep).getByTestId('encrypted-file-wallet-password-input')).toBeInTheDocument();
    expect(within(unlockStep).getByTestId('encrypted-file-wallet-password-consent')).toBeInTheDocument();
    // The CTA is pinned in the layout's footer: it must still be inside the step's own page, or a
    // harness scoped to the step cannot reach it.
    expect(within(unlockStep).getByTestId('encrypted-file-wallet-password-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('export-file-password')).not.toBeInTheDocument();
  });

  it('replaces the wallet-password step with the export step rather than stacking them', async () => {
    render(<EncryptedFileFlow />);
    await screen.findByTestId('encrypted-file-wallet-password');
    await advanceToExportStep();

    expect(screen.queryByTestId('encrypted-file-wallet-password')).not.toBeInTheDocument();
    expect(within(flowRoot()).getByTestId('export-file-password')).toBeInTheDocument();
  });

  it('keeps the export step’s three fields and its pinned CTA inside the export step', async () => {
    render(<EncryptedFileFlow />);
    await screen.findByTestId('encrypted-file-wallet-password');
    await advanceToExportStep();

    const fileStep = within(flowRoot()).getByTestId('export-file-password');
    expect(within(fileStep).getByTestId('export-file-name-input')).toBeInTheDocument();
    expect(within(fileStep).getByTestId('export-file-password-input')).toBeInTheDocument();
    expect(within(fileStep).getByTestId('export-file-password-verify-input')).toBeInTheDocument();
    expect(within(fileStep).getByTestId('export-file-submit')).toBeInTheDocument();
  });

  it('enables the export CTA once the name and both passwords are filled and match', async () => {
    render(<EncryptedFileFlow />);
    await screen.findByTestId('encrypted-file-wallet-password');
    await advanceToExportStep();

    const fileStep = within(flowRoot()).getByTestId('export-file-password');
    const submit = within(fileStep).getByTestId('export-file-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(within(fileStep).getByTestId('export-file-name-input'), { target: { value: 'my-backup' } });
    fireEvent.change(within(fileStep).getByTestId('export-file-password-input'), {
      target: { value: FILE_PASSWORD }
    });
    expect(submit).toBeDisabled();

    fireEvent.change(within(fileStep).getByTestId('export-file-password-verify-input'), {
      target: { value: FILE_PASSWORD }
    });
    await waitFor(() => expect(submit).toBeEnabled());
  });
});
