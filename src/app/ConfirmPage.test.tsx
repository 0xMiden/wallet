/* eslint-disable no-restricted-globals */
import React from 'react';

import { Address, SigningInputs, SigningInputsType, Word } from '@miden-sdk/miden-sdk/lazy';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useMidenContext, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getNetworkId } from 'lib/miden-chain/constants';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { useLocation } from 'lib/woozie';

import ConfirmPage from './ConfirmPage';
import { ConfirmPageSelectors } from './ConfirmPage.selectors';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ESM wallet-adapter package: only the `PrivateDataPermission` enum is read.
jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' }
}));

// The `/lazy` SDK subpath is mapped to wasmMock, which lacks the members this
// component needs. Provide controllable stand-ins for the exact surface used.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Address: { fromAccountId: jest.fn() },
  FungibleAsset: jest.fn(),
  InputNoteState: {
    ConsumedAuthenticatedLocal: 'ConsumedAuthenticatedLocal',
    ConsumedUnauthenticatedLocal: 'ConsumedUnauthenticatedLocal',
    ConsumedExternal: 'ConsumedExternal'
  },
  SigningInputs: { deserialize: jest.fn() },
  SigningInputsType: { TransactionSummary: 'TransactionSummary', Arbitrary: 'Arbitrary', Blind: 'Blind' },
  Word: { deserialize: jest.fn() }
}));

// `t` echoes the key back so rendered copy is assertable by key. It is a shared
// jest.fn so individual tests can override interpolation behaviour.
const t = jest.fn((key: string) => key);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (...args: any[]) => (t as any)(...args) })
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: jest.fn(),
  useAccount: jest.fn(),
  MIDEN_METADATA: { decimals: 6, symbol: 'MIDEN', name: 'Miden' }
}));

jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: jest.fn()
}));

jest.mock('lib/miden-chain/constants', () => ({
  getNetworkId: jest.fn(() => 'testnet')
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: jest.fn(() => false)
}));

jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: any) => `${amount}`
}));

jest.mock('lib/store', () => ({
  useWalletStore: { getState: jest.fn(() => ({ openTransactionModal: jest.fn() })) }
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  useLocation: jest.fn(),
  navigate: jest.fn()
}));

// Tippy pulls in `tippy.js`; the component only needs a ref back.
jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: () => ({ current: null })
}));

// Layout/boundary wrappers: render children so `ConfirmDAppForm` mounts.
jest.mock('app/layouts/ContentContainer', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="content-container">{children}</div>
}));
jest.mock('app/ErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: any) => <div data-testid="error-boundary">{children}</div>
}));
jest.mock('app/atoms/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => <div data-testid="spinner" />
}));
jest.mock('app/pages/Unlock', () => ({
  __esModule: true,
  default: ({ openForgotPasswordInFullPage }: any) => (
    <div data-testid="unlock" data-full-page={String(openForgotPasswordInFullPage)} />
  )
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ children, onClick, isLoading, variant }: any) => (
    <button type="button" onClick={onClick} data-loading={String(!!isLoading)} data-variant={variant}>
      {children}
    </button>
  )
}));

jest.mock('lib/analytics', () => {
  const React2 = require('react');
  return { CustomRpsContext: React2.createContext(undefined) };
});

jest.mock('./atoms/Alert', () => ({
  __esModule: true,
  default: ({ description, onClose }: any) => (
    <div data-testid="alert">
      <span>{description}</span>
      <button type="button" data-testid="alert-close" onClick={onClose}>
        close
      </button>
    </div>
  )
}));
jest.mock('./atoms/FormSecondaryButton', () => ({
  __esModule: true,
  default: ({ children, onClick }: any) => (
    <button type="button" onClick={onClick} data-testid="form-secondary">
      {children}
    </button>
  )
}));
jest.mock('./atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: ({ children, onClick, loading, testID }: any) => (
    <button type="button" onClick={onClick} data-loading={String(!!loading)} data-testid={testID}>
      {children}
    </button>
  )
}));
jest.mock('./atoms/Name', () => ({
  __esModule: true,
  default: ({ children }: any) => <span data-testid="name">{children}</span>
}));
jest.mock('./icons/v2', () => ({
  Icon: ({ name }: any) => <span data-testid="icon" data-name={name} />,
  IconName: { Globe: 'Globe', WarningFill: 'WarningFill', Download: 'Download' }
}));
jest.mock('./templates/AccountBanner', () => ({
  __esModule: true,
  default: ({ networkRpc }: any) => <div data-testid="account-banner" data-rpc={networkRpc} />
}));
jest.mock('./templates/ConnectBanner', () => ({
  __esModule: true,
  default: ({ origin }: any) => <div data-testid="connect-banner" data-origin={origin} />
}));
jest.mock('./templates/PrivateDataPermissionBanner', () => ({
  __esModule: true,
  default: ({ isPublicAccount }: any) => <div data-testid="pdp-banner" data-public={String(isPublicAccount)} />
}));
jest.mock('./templates/PrivateDataPermissionCheckbox', () => ({
  __esModule: true,
  default: ({ setChecked }: any) => (
    <button type="button" data-testid="pdp-checkbox" onClick={() => setChecked(true)}>
      check
    </button>
  )
}));

// ---------------------------------------------------------------------------
// Typed handles
// ---------------------------------------------------------------------------

const mockUseMidenContext = useMidenContext as jest.Mock;
const mockUseAccount = useAccount as jest.Mock;
const mockUseRetryableSWR = useRetryableSWR as jest.Mock;
const mockUseLocation = useLocation as jest.Mock;
const mockGetTokenMetadata = getTokenMetadata as jest.Mock;
const mockIsDelegateProofEnabled = isDelegateProofEnabled as jest.Mock;
const mockGetNetworkId = getNetworkId as jest.Mock;
const mockWord = Word as unknown as { deserialize: jest.Mock };
const mockSigningInputs = SigningInputs as unknown as { deserialize: jest.Mock };
const mockAddress = Address as unknown as { fromAccountId: jest.Mock };

const UPON_REQUEST = 'UPON_REQUEST';
const AUTO = 'AUTO';

const ctx = {
  ready: true,
  getDAppPayload: jest.fn(),
  confirmDAppPermission: jest.fn(),
  confirmDAppTransaction: jest.fn(),
  confirmDAppPrivateNotes: jest.fn(),
  confirmDAppSign: jest.fn(),
  confirmDAppAssets: jest.fn(),
  confirmDAppImportPrivateNote: jest.fn(),
  confirmDAppConsumableNotes: jest.fn()
};

const ACCOUNT = { name: 'Main', publicKey: 'mtst1account_ABCDpub', isPublic: true };

const APP_META = { name: 'DApp', description: 'x', iconUri: '' };

const baseFields = (origin = 'https://dapp.example.com') => ({
  origin,
  networkRpc: 'https://rpc.testnet.miden.io',
  appMeta: APP_META
});

const setPayload = (payload: any) => {
  mockUseRetryableSWR.mockReturnValue({ data: payload });
};

const b64 = (s: string) => Buffer.from(s, 'binary').toString('base64');

let consoleErrorSpy: jest.SpyInstance;
let consoleLogSpy: jest.SpyInstance;
let clickSpy: jest.SpyInstance;
let createObjSpy: jest.Mock;
let revokeObjSpy: jest.Mock;

beforeAll(() => {
  createObjSpy = jest.fn(() => 'blob:mock');
  revokeObjSpy = jest.fn();
  (URL as any).createObjectURL = createObjSpy;
  (URL as any).revokeObjectURL = revokeObjSpy;
  // jsdom logs "navigation not implemented" when an <a> with href is clicked.
  clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterAll(() => {
  clickSpy.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  t.mockImplementation((key: string) => key);
  ctx.ready = true;
  mockUseMidenContext.mockReturnValue(ctx);
  mockUseAccount.mockReturnValue(ACCOUNT);
  mockUseLocation.mockReturnValue({ search: '?id=req-1' });
  mockIsDelegateProofEnabled.mockReturnValue(false);
  mockGetNetworkId.mockReturnValue('testnet');
  mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'TOK' });
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// ConfirmPage (default export) gate
// ---------------------------------------------------------------------------

describe('ConfirmPage gate', () => {
  it('renders the Unlock screen when the context is not ready', () => {
    ctx.ready = false;
    setPayload({ type: 'assets', ...baseFields() });
    render(<ConfirmPage />);

    expect(screen.getByTestId('unlock')).toHaveAttribute('data-full-page', 'true');
    expect(screen.queryByTestId('content-container')).not.toBeInTheDocument();
  });

  it('renders the confirm form inside the container/boundary/suspense when ready', () => {
    setPayload({ type: 'assets', ...baseFields() });
    render(<ConfirmPage />);

    expect(screen.getByTestId('content-container')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.queryByTestId('unlock')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ConfirmDAppForm — id derivation
// ---------------------------------------------------------------------------

describe('ConfirmDAppForm id derivation', () => {
  it('throws when the location has no id query param', () => {
    mockUseLocation.mockReturnValue({ search: '?foo=bar' });
    setPayload({ type: 'assets', ...baseFields() });
    // The throw happens during render; ErrorBoundary is a passthrough mock, so
    // it propagates out of render().
    expect(() => render(<ConfirmPage />)).toThrow('notIdentified');
  });
});

// ---------------------------------------------------------------------------
// connect payload
// ---------------------------------------------------------------------------

describe('connect payload', () => {
  const connectPayload = (overrides: any = {}) => ({
    type: 'connect',
    ...baseFields(),
    privateDataPermission: UPON_REQUEST,
    existingPermission: false,
    allowedPrivateData: ['balance'],
    ...overrides
  });

  it('renders the connect banner, permission banner and account banner (UponRequest)', () => {
    setPayload(connectPayload());
    render(<ConfirmPage />);

    expect(screen.getByTestId('connect-banner')).toHaveAttribute('data-origin', 'https://dapp.example.com');
    expect(screen.getByTestId('pdp-banner')).toBeInTheDocument();
    expect(screen.getByTestId('account-banner')).toHaveAttribute('data-rpc', 'https://rpc.testnet.miden.io');
    expect(screen.getByText('connectToWebsite')).toBeInTheDocument();
    // UponRequest + public account => no private-data checkbox.
    expect(screen.queryByTestId('pdp-checkbox')).not.toBeInTheDocument();
    // Confirm/decline labels.
    expect(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton)).toHaveTextContent('connect');
    expect(screen.getByText('deny')).toBeInTheDocument();
  });

  it('auto-confirms an existing permission during render', () => {
    setPayload(connectPayload({ existingPermission: true }));
    render(<ConfirmPage />);

    expect(ctx.confirmDAppPermission).toHaveBeenCalledWith('req-1', true, ACCOUNT.publicKey, UPON_REQUEST, ['balance']);
  });

  it('shows the private-data checkbox when permission is Auto and account is non-public', () => {
    mockUseAccount.mockReturnValue({ ...ACCOUNT, isPublic: false });
    setPayload(connectPayload({ privateDataPermission: AUTO }));
    render(<ConfirmPage />);

    expect(screen.getByTestId('pdp-checkbox')).toBeInTheDocument();
  });

  it('confirms the connection via onConfirm when the confirm button is clicked', async () => {
    ctx.confirmDAppPermission.mockResolvedValue(undefined);
    setPayload(connectPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton));
    });

    await waitFor(() =>
      expect(ctx.confirmDAppPermission).toHaveBeenLastCalledWith('req-1', true, ACCOUNT.publicKey, UPON_REQUEST, [
        'balance'
      ])
    );
  });

  it('blocks confirmation and surfaces an error when the private-data checkbox is unchecked', async () => {
    mockUseAccount.mockReturnValue({ ...ACCOUNT, isPublic: false });
    setPayload(connectPayload({ privateDataPermission: AUTO }));
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton));
    });

    // Error alert appears and the confirm button flips to the retry variant.
    await waitFor(() => expect(screen.getByTestId('alert')).toBeInTheDocument());
    expect(screen.getByText('confirmError')).toBeInTheDocument();
    expect(screen.getByTestId(ConfirmPageSelectors.ConnectAction_RetryButton)).toHaveTextContent('retry');
    // The permission was never actually confirmed.
    expect(ctx.confirmDAppPermission).not.toHaveBeenCalled();
  });

  it('confirms once the private-data checkbox is checked', async () => {
    mockUseAccount.mockReturnValue({ ...ACCOUNT, isPublic: false });
    ctx.confirmDAppPermission.mockResolvedValue(undefined);
    setPayload(connectPayload({ privateDataPermission: AUTO }));
    render(<ConfirmPage />);

    fireEvent.click(screen.getByTestId('pdp-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton));
    });

    await waitFor(() => expect(ctx.confirmDAppPermission).toHaveBeenCalledTimes(1));
  });

  it('closes the error alert when its close button is clicked', async () => {
    mockUseAccount.mockReturnValue({ ...ACCOUNT, isPublic: false });
    setPayload(connectPayload({ privateDataPermission: AUTO }));
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton));
    });
    await waitFor(() => expect(screen.getByTestId('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('alert-close'));
    await waitFor(() => expect(screen.queryByTestId('alert')).not.toBeInTheDocument());
  });

  it('declines the connection and ignores concurrent clicks while a confirm is pending', async () => {
    // Deferred confirm keeps `confirming` true so the guard branches fire.
    let resolveConfirm: () => void = () => {};
    ctx.confirmDAppPermission.mockImplementation(() => new Promise<void>(res => (resolveConfirm = res)));
    setPayload(connectPayload());
    render(<ConfirmPage />);

    const confirmBtn = screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton);
    const declineBtn = screen.getByText('deny');

    // First click starts the (pending) confirm.
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(ctx.confirmDAppPermission).toHaveBeenCalledTimes(1);

    // Second confirm + a decline while pending are both swallowed by the guard.
    await act(async () => {
      fireEvent.click(confirmBtn);
      fireEvent.click(declineBtn);
    });
    expect(ctx.confirmDAppPermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm();
    });
  });

  it('declines the connection with confirmed=false', async () => {
    ctx.confirmDAppPermission.mockResolvedValue(undefined);
    setPayload(connectPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByText('deny'));
    });

    await waitFor(() =>
      expect(ctx.confirmDAppPermission).toHaveBeenCalledWith('req-1', false, ACCOUNT.publicKey, UPON_REQUEST, [
        'balance'
      ])
    );
  });

  it('surfaces an error thrown by onConfirm through the error alert', async () => {
    ctx.confirmDAppPermission.mockRejectedValue(new Error('network boom'));
    setPayload(connectPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton));
    });

    await waitFor(() => expect(screen.getByText('network boom')).toBeInTheDocument());
  });

  it('falls back to the generic error message when the thrown error has none', async () => {
    ctx.confirmDAppPermission.mockRejectedValue({});
    setPayload(connectPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConnectAction_ConnectButton));
    });

    await waitFor(() => expect(screen.getByText('smthWentWrong')).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// transaction / consume payloads (+ PayloadContent)
// ---------------------------------------------------------------------------

describe('transaction payload', () => {
  const txPayload = () => ({
    type: 'transaction',
    ...baseFields(),
    sourcePublicKey: 'src_key',
    preview: {},
    transactionMessages: [
      'Sending funds',
      'to a recipient',
      'Amount, 1000000',
      'Recipient, mtst1abcdef_ghij',
      'Fee, 5',
      'NoComma'
    ]
  });

  it('renders the transaction rows with amount/recipient/plain formatting', () => {
    setPayload(txPayload());
    render(<ConfirmPage />);

    expect(screen.getByText('requestsATransaction')).toBeInTheDocument();
    // account block
    expect(screen.getByText(ACCOUNT.name)).toBeInTheDocument();
    // Amount 1000000 microcredits / 10^6 => "1"
    expect(screen.getByText('1')).toBeInTheDocument();
    // Plain label passes value through untouched.
    expect(screen.getByText('Fee')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    // The 'Recipient' label row exists (value is truncated).
    expect(screen.getByText('Recipient')).toBeInTheDocument();
    // 'NoComma' message => label with empty value.
    expect(screen.getByText('NoComma')).toBeInTheDocument();
  });

  it('opens the transaction modal and confirms with the delegate flag', async () => {
    mockIsDelegateProofEnabled.mockReturnValue(true);
    ctx.confirmDAppTransaction.mockResolvedValue(undefined);
    setPayload(txPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.TransactionAction_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppTransaction).toHaveBeenCalledWith('req-1', true, true));
  });

  it('renders the payloadError instead of the derived content when present', () => {
    setPayload({ ...txPayload(), error: 'preview failed' });
    render(<ConfirmPage />);

    expect(screen.getByText('preview failed')).toBeInTheDocument();
  });
});

describe('consume payload', () => {
  const consumePayload = () => ({
    type: 'consume',
    ...baseFields(),
    sourcePublicKey: 'src_key',
    noteId: '0xnoteidlong1234567890',
    transactionMessages: ['Consuming note', 'Recipient, mtst1abcdef_ghij', 'Extra, plainvalue', 'NoCommaConsume']
  });

  it('renders consume rows including the note id and recipient/plain/empty formatting', () => {
    setPayload(consumePayload());
    render(<ConfirmPage />);

    expect(screen.getByText('requestsToConsumeNote')).toBeInTheDocument();
    expect(screen.getByText('noteId')).toBeInTheDocument();
    expect(screen.getByText('Recipient')).toBeInTheDocument();
    expect(screen.getByText('Extra')).toBeInTheDocument();
    expect(screen.getByText('plainvalue')).toBeInTheDocument();
    // A comma-less message => label with an empty value (nullish fallback).
    expect(screen.getByText('NoCommaConsume')).toBeInTheDocument();
  });

  it('confirms a consume via confirmDAppTransaction', async () => {
    ctx.confirmDAppTransaction.mockResolvedValue(undefined);
    setPayload(consumePayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.ConsumeAction_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppTransaction).toHaveBeenCalledWith('req-1', true, false));
  });
});

// ---------------------------------------------------------------------------
// privateNotes payload (+ downloadData)
// ---------------------------------------------------------------------------

describe('privateNotes payload', () => {
  const pnPayload = () => ({
    type: 'privateNotes',
    ...baseFields(),
    sourcePublicKey: 'mtst1abcdef_ghij',
    privateNotes: [{ id: 'n1' }],
    preview: {}
  });

  it('downloads the private-note data when the download button is clicked', () => {
    setPayload(pnPayload());
    render(<ConfirmPage />);

    // The intro copy is split across text nodes by a <br/>; match the button.
    expect(screen.getByText('downloadPrivateNoteData')).toBeInTheDocument();
    fireEvent.click(screen.getByText('downloadPrivateNoteData'));

    expect(createObjSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('confirms private notes via confirmDAppPrivateNotes', async () => {
    ctx.confirmDAppPrivateNotes.mockResolvedValue(undefined);
    setPayload(pnPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.RequestPrivateNotes_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppPrivateNotes).toHaveBeenCalledWith('req-1', true));
  });
});

// ---------------------------------------------------------------------------
// sign payload (+ PayloadContent word / SigningInputsPayloadContent)
// ---------------------------------------------------------------------------

describe('sign payload — word', () => {
  const wordPayload = () => ({
    type: 'sign',
    ...baseFields(),
    sourcePublicKey: 'src',
    payload: b64('word-bytes'),
    kind: 'word',
    preview: {}
  });

  it('renders the deserialized word hex', () => {
    mockWord.deserialize.mockReturnValue({ toHex: () => '0xdeadbeefcafe' });
    setPayload(wordPayload());
    render(<ConfirmPage />);

    expect(screen.getByText('signTheFollowingWord')).toBeInTheDocument();
    expect(screen.getByText('requestsYourSignature')).toBeInTheDocument();
  });

  it('logs and shows the invalid-payload copy when deserialization throws', () => {
    mockWord.deserialize.mockImplementation(() => {
      throw new Error('bad word');
    });
    setPayload(wordPayload());
    render(<ConfirmPage />);

    // Still renders the sign prompt; the word text is the invalid fallback.
    expect(screen.getByText('signTheFollowingWord')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('confirms the signature via confirmDAppSign', async () => {
    mockWord.deserialize.mockReturnValue({ toHex: () => '0xabc' });
    ctx.confirmDAppSign.mockResolvedValue(undefined);
    setPayload(wordPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.SignData_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppSign).toHaveBeenCalledWith('req-1', true));
  });
});

describe('sign payload — signingInputs', () => {
  const siPayload = () => ({
    type: 'sign',
    ...baseFields(),
    sourcePublicKey: 'src',
    payload: b64('signing-bytes'),
    kind: 'signingInputs',
    preview: {}
  });

  const makeAsset = (id: string, amount: number) => ({
    faucetId: () => ({ toString: () => id }),
    amount: () => amount
  });

  const transactionSummary = ({
    vaultEmpty = false,
    storageEmpty = false,
    removed = [] as any[],
    added = [] as any[]
  }) => {
    const vault = {
      isEmpty: () => vaultEmpty,
      removedFungibleAssets: () => removed,
      addedFungibleAssets: () => added
    };
    const accountDelta = {
      id: () => 'acc-id',
      vault: () => vault,
      storage: () => ({ isEmpty: () => storageEmpty })
    };
    const ts = {
      accountDelta: () => accountDelta,
      inputNotes: () => ({ numNotes: () => 2 }),
      outputNotes: () => ({ numNotes: () => 3 })
    };
    return { variantType: SigningInputsType.TransactionSummary, transactionSummaryPayload: () => ts };
  };

  it('shows the parse-failure copy when SigningInputs.deserialize throws', () => {
    mockSigningInputs.deserialize.mockImplementation(() => {
      throw new Error('bad si');
    });
    setPayload(siPayload());
    render(<ConfirmPage />);

    expect(screen.getByText('failedToParseSigningPayload')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('renders a TransactionSummary with asset changes and storage warning', async () => {
    mockAddress.fromAccountId.mockReturnValue({ toBech32: () => 'mtst1accbech_wxyz' });
    // Two removed + two added assets, mixing present/absent symbols to hit both
    // sides of the `symbol ?? unknown` fallback.
    mockGetTokenMetadata.mockImplementation((id: string) =>
      Promise.resolve({ decimals: 6, symbol: id.includes('null') ? null : `SYM-${id}` })
    );
    setPayload(siPayload());
    mockSigningInputs.deserialize.mockReturnValue(
      transactionSummary({
        vaultEmpty: false,
        storageEmpty: false,
        removed: [makeAsset('rem1', 100), makeAsset('rem-null', 200)],
        added: [makeAsset('add1', 300), makeAsset('add-null', 400)]
      })
    );
    render(<ConfirmPage />);

    // Note counts render immediately.
    expect(screen.getByText('inputNotesConsumed')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Storage changed => warning + yes.
    expect(screen.getByText('yes')).toBeInTheDocument();

    // Asset detail rows appear after the metadata effects resolve.
    await waitFor(() => expect(screen.getByText('100 SYM-rem1')).toBeInTheDocument());
    expect(screen.getByText('200 unknown')).toBeInTheDocument();
    expect(screen.getByText('300 SYM-add1')).toBeInTheDocument();
    expect(screen.getByText('400 unknown')).toBeInTheDocument();
  });

  it('renders a TransactionSummary with an empty vault and empty storage', async () => {
    mockAddress.fromAccountId.mockReturnValue({ toBech32: () => 'mtst1accbech_wxyz' });
    setPayload(siPayload());
    mockSigningInputs.deserialize.mockReturnValue(transactionSummary({ vaultEmpty: true, storageEmpty: true }));
    render(<ConfirmPage />);

    // Storage unchanged => "no"; no asset-changes section.
    await waitFor(() => expect(screen.getByText('no')).toBeInTheDocument());
    expect(screen.queryByText('assetChanges')).not.toBeInTheDocument();
  });

  it('downloads the full summary binary when the download button is clicked', async () => {
    mockAddress.fromAccountId.mockReturnValue({ toBech32: () => 'mtst1accbech_wxyz' });
    setPayload(siPayload());
    mockSigningInputs.deserialize.mockReturnValue(transactionSummary({ vaultEmpty: true, storageEmpty: true }));
    render(<ConfirmPage />);

    await waitFor(() => expect(screen.getByText('downloadFullSummary')).toBeInTheDocument());
    fireEvent.click(screen.getByText('downloadFullSummary'));

    expect(createObjSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    // The revoke is scheduled on a 0ms timeout after the click.
    await waitFor(() => expect(revokeObjSpy).toHaveBeenCalled());
  });

  it('renders the arbitrary-payload copy for the Arbitrary variant', () => {
    setPayload(siPayload());
    mockSigningInputs.deserialize.mockReturnValue({ variantType: SigningInputsType.Arbitrary });
    render(<ConfirmPage />);

    expect(screen.getByText('signArbitraryPayload')).toBeInTheDocument();
  });

  it('renders the blind-commitment copy for the Blind variant', () => {
    setPayload(siPayload());
    mockSigningInputs.deserialize.mockReturnValue({ variantType: SigningInputsType.Blind });
    render(<ConfirmPage />);

    expect(screen.getByText('signBlindCommitment')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// assets / importPrivateNote / consumableNotes (noPreview default + onConfirm)
// ---------------------------------------------------------------------------

describe('assets payload', () => {
  const assetsPayload = () => ({ type: 'assets', ...baseFields(), sourcePublicKey: 's', assets: [], preview: {} });

  it('renders the request-assets prompt with the no-preview default content', () => {
    setPayload(assetsPayload());
    render(<ConfirmPage />);

    expect(screen.getByText('requestsAssets')).toBeInTheDocument();
    expect(screen.getByText('noPreview')).toBeInTheDocument();
  });

  it('confirms assets via confirmDAppAssets', async () => {
    ctx.confirmDAppAssets.mockResolvedValue(undefined);
    setPayload(assetsPayload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.RequestAssets_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppAssets).toHaveBeenCalledWith('req-1', true));
  });

  it('hides the Payload header when the header label is empty', () => {
    // Drive the falsy side of the `t('Payload') && <h2>` branch.
    t.mockImplementation((key: string) => (key === 'Payload' ? '' : key));
    setPayload(assetsPayload());
    render(<ConfirmPage />);

    expect(screen.queryByText('Payload')).not.toBeInTheDocument();
  });
});

describe('importPrivateNote payload', () => {
  const payload = () => ({
    type: 'importPrivateNote',
    ...baseFields(),
    sourcePublicKey: 's',
    note: 'noteblob',
    preview: {}
  });

  it('renders the import-private-note prompt', () => {
    setPayload(payload());
    render(<ConfirmPage />);
    expect(screen.getByText('importPrivateNote')).toBeInTheDocument();
  });

  it('confirms via confirmDAppImportPrivateNote', async () => {
    ctx.confirmDAppImportPrivateNote.mockResolvedValue(undefined);
    setPayload(payload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.RequestImportPrivateNote_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppImportPrivateNote).toHaveBeenCalledWith('req-1', true));
  });
});

describe('consumableNotes payload', () => {
  const payload = () => ({
    type: 'consumableNotes',
    ...baseFields(),
    sourcePublicKey: 's',
    consumableNotes: [],
    preview: {}
  });

  it('renders the consumable-notes prompt', () => {
    setPayload(payload());
    render(<ConfirmPage />);
    expect(screen.getByText('requestsConsumableNotes')).toBeInTheDocument();
  });

  it('confirms via confirmDAppConsumableNotes', async () => {
    ctx.confirmDAppConsumableNotes.mockResolvedValue(undefined);
    setPayload(payload());
    render(<ConfirmPage />);

    await act(async () => {
      fireEvent.click(screen.getByTestId(ConfirmPageSelectors.RequestConsumableNotes_AcceptButton));
    });

    await waitFor(() => expect(ctx.confirmDAppConsumableNotes).toHaveBeenCalledWith('req-1', true));
  });
});
