import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG_SNAPSHOT, TEST_MIDEN_USDC_FAUCET } from 'lib/epoch/testing/bridge-config';
import type { IBridgedReceiveExtraInputs, IBridgedReceivePhase, ITransaction } from 'lib/miden/db/types';
import { ITransactionStatus } from 'lib/miden/db/types';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { NO_EXPLORER_CHAIN } from 'lib/walletconnect/testing/chains';

import { EvmBridgeDepositStatus } from './EvmBridgeDepositStatus';

/**
 * Mirrors `EarnWithdrawStatus.test.tsx` - this screen's own processing/failed body moved onto
 * the same `Hero` shape, so it gets the same coverage: processing vs. failed title, and the
 * recorded-error vs. generic-fallback message.
 */

let mockRowState: { row?: ITransaction; loaded: boolean } = { row: undefined, loaded: false };
let mockAssetsMetadata: Record<string, AssetMetadata> = {};

// The screen resolves the delivered faucet synchronously from the store, as the transaction badge does.
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: { assetsMetadata: Record<string, AssetMetadata> }) => T) =>
    selector({ assetsMetadata: mockAssetsMetadata })
}));

// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'native-faucet'
}));

// Real base-unit scaling: the shared `lib/i18n/numbers` manual mock has no `formatBigInt`.
jest.mock('lib/shared/format', () => ({
  formatAmount: (amount: bigint, decimals: number) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').formatBigInt(amount, decimals)
}));

let mockTranslatedFallback = false;
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      mockTranslatedFallback && key === 'transactionErrorDescription' ? 'Visible generic bridge failure' : key
  })
}));

jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => mockRowState
}));

jest.mock('components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />
}));

jest.mock('lib/mobile/external-browser', () => ({ openExternalUrl: jest.fn() }));

// The registry's chains, plus one the wallet knows no explorer for.
jest.mock('lib/walletconnect/config', () => {
  const chains = jest.requireActual<typeof import('lib/walletconnect/testing/chains')>(
    'lib/walletconnect/testing/chains'
  );
  return chains.walletConnectConfigMock([chains.NO_EXPLORER_CHAIN]);
});

// The step list animates with framer; here only its inputs matter.
jest.mock('./UsdcxDepositSteps', () => ({
  UsdcxDepositSteps: ({ sourceChainId, phase }: Record<string, unknown>) => (
    <div data-testid="usdcx-deposit-steps" data-source-chain={String(sourceChainId)}>
      {String(phase)}
    </div>
  )
}));

// The Arc leg's own component signs through wagmi; here only its placement and inputs matter.
jest.mock('./UsdcxExecuteAction', () => ({
  UsdcxExecuteAction: ({ txId, sourceChainId, phase, cctp }: Record<string, unknown>) => (
    <div data-testid="usdcx-execute-action" data-tx-id={String(txId)} data-source-chain={String(sourceChainId)}>
      {String(phase)}:{cctp ? 'leg' : 'no-leg'}
    </div>
  )
}));

jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onClose }: { title: string; onClose?: () => void }) => (
    <header>
      {title}
      {onClose && <button type="button" aria-label="close" onClick={onClose} />}
    </header>
  )
}));

// `className` forwarded: the real Button caps its width unless the caller lifts it (#1469).
jest.mock('components/Button', () => ({
  Button: ({
    children,
    onClick,
    title,
    className
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    title?: string;
    className?: string;
  }) => (
    <button type="button" className={className} onClick={onClick}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('screens/generating-transaction/components', () => ({
  TransactionHeroIcon: ({ state }: { state: string }) => <div data-testid="hero-state">{state}</div>
}));

// `fillForArrow` surfaced as an attribute: the real badge paints it into an SVG the stub does
// not draw, and a bridge screen handing it the default (the Send blue) is the bug below.
jest.mock('screens/generating-transaction/TransactionSummaryBadge', () => ({
  TransactionSummaryBadge: ({
    lhs,
    rhs,
    fillForArrow
  }: {
    lhs?: React.ReactNode;
    rhs?: React.ReactNode;
    fillForArrow?: string;
  }) => (
    <div data-testid="summary-badge" data-arrow-fill={fillForArrow}>
      {lhs} → {rhs}
    </div>
  )
}));

// Children rendered, so the submitted branch's own badge is reachable from this suite.
jest.mock('screens/generating-transaction/success/TransactionSuccessLayout', () => ({
  TransactionSuccessLayout: ({
    title,
    footerDescription,
    secondaryAction,
    primaryAction,
    children
  }: {
    title: string;
    footerDescription?: string;
    secondaryAction?: { label: string; onClick: () => void };
    primaryAction?: { label: string; onClick: () => void };
    children?: React.ReactNode;
  }) => (
    <div data-testid="success-layout">
      {title}
      <p data-testid="success-footer">{footerDescription}</p>
      {primaryAction && <button onClick={primaryAction.onClick}>{primaryAction.label}</button>}
      {secondaryAction && <button onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
      {children}
    </div>
  ),
  ReceiptRows: ({ rows }: { rows: { label: string; value: string }[] }) => (
    <dl data-testid="receipt-rows">
      {rows.map(row => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}));

const makeRow = (extraInputs: IBridgedReceiveExtraInputs, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'bridge-1',
  type: 'bridged-receive',
  accountId: 'miden-account',
  amount: 0n,
  faucetId: 'miden-usdc',
  status: ITransactionStatus.Completed,
  initiatedAt: 1,
  completedAt: 1,
  displayMessage: 'Bridging in',
  displayIcon: 'DEFAULT',
  extraInputs,
  ...overrides
});

const makeInputs = (overrides: Partial<IBridgedReceiveExtraInputs> = {}): IBridgedReceiveExtraInputs => ({
  provider: 'epoch',
  sourceAddress: '0x1111111111111111111111111111111111111111',
  sourceAmount: '12.5000',
  sourceSymbol: 'USDC',
  phase: 'submitting',
  ...overrides
});

describe('EvmBridgeDepositStatus', () => {
  const onDone = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRowState = { row: undefined, loaded: false };
    mockAssetsMetadata = { 'miden-usdc': { symbol: 'USDC', name: 'USDC', decimals: 6 } };
  });

  it('shows a spinner until a transaction row is available', () => {
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows the processing title and description before the deposit is submitted', () => {
    mockRowState = { row: makeRow(makeInputs()), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByText('bridgeDepositProcessing')).toBeInTheDocument();
    expect(screen.getByText('bridgeDepositProcessingDescription')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('processing');
    expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 USDC → Miden');
    // A bridge row is the slate wherever it is drawn, so its arrow is too - not the badge's
    // default, which is the Send flow's blue.
    expect(screen.getByTestId('summary-badge')).toHaveAttribute('data-arrow-fill', '#777487');

    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('hides dismissal during an active USDCx submission (next prompt: %s)', awaiting => {
    mockRowState = { row: makeRow(makeInputs({ provider: 'usdcx' })), loaded: true };
    render(
      <EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} submissionPending awaitingNextConfirmation={awaiting} />
    );

    expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'hide' })).not.toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('processing');
  });

  it.each(['failed', 'delivering', 'ready', 'received'] satisfies IBridgedReceivePhase[])(
    'restores dismissal at %s even if the submission callback has not settled yet',
    phase => {
      mockRowState = { row: makeRow(makeInputs({ provider: 'usdcx', phase })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} submissionPending />);
      fireEvent.click(screen.getByRole('button', { name: 'done' }));
      expect(onDone).toHaveBeenCalledTimes(1);
    }
  );

  it('allows a submitted hash awaiting background receipt recovery to be hidden after local work settles', () => {
    mockRowState = { row: makeRow(makeInputs({ provider: 'usdcx' })), loaded: true };
    const view = render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} submissionPending />);
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each(['epoch', 'agglayer'] as const)('keeps %s processing dismissible', provider => {
    mockRowState = { row: makeRow(makeInputs({ provider })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} submissionPending />);
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('names the pending wallet confirmation while the deposit waits for the next prompt', () => {
    // #1290: between the approve landing and the bridge prompt opening the wallet is silent for
    // several seconds, and the generic processing copy reads as "done" - users left mid-flow.
    mockRowState = { row: makeRow(makeInputs()), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} awaitingNextConfirmation />);

    expect(screen.getByText('bridgeDepositAwaitingNextConfirmation')).toBeInTheDocument();
    expect(screen.getByText('bridgeDepositAwaitingNextConfirmationDescription')).toBeInTheDocument();
    expect(screen.queryByText('bridgeDepositProcessingDescription')).not.toBeInTheDocument();
    // The wait appears while the user is looking at their wallet, so it is announced.
    expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveAttribute('role', 'status');
    // Still in flight: the spinner state and the Hide affordance are unchanged.
    expect(screen.getByTestId('hero-state')).toHaveTextContent('processing');
    expect(screen.getByRole('button', { name: 'hide' })).toBeInTheDocument();
  });

  it('keeps the failure message when a confirmation was pending as the deposit failed', () => {
    // A rejected prompt sets the row to failed; the stale "waiting" copy must not outrank the error.
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'failed', error: 'user rejected the bridge request' })),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} awaitingNextConfirmation />);

    expect(screen.getByText('bridgeDepositFailed')).toBeInTheDocument();
    expect(screen.getByText('user rejected the bridge request')).toBeInTheDocument();
    expect(screen.queryByText('bridgeDepositAwaitingNextConfirmation')).not.toBeInTheDocument();
  });

  it('shows the failed title and its recorded error', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'failed', error: 'solver rejected the deposit' })),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByText('bridgeDepositFailed')).toBeInTheDocument();
    expect(screen.getByText('solver rejected the deposit')).toBeInTheDocument();
    expect(screen.getByTestId('hero-state')).toHaveTextContent('failed');

    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic transaction error for an unstamped failure', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'failed' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByText('transactionErrorDescription')).toBeInTheDocument();
  });

  // #1469: the in-flight and failed branches drew their own frame, so on a screen wider than the
  // Button's 370px cap the CTA sat at the left gutter and the root scrolled a long error sideways.
  describe('layout wider than the button cap', () => {
    const LONG_TOKEN_ERROR = `execution reverted: 0x${'ab'.repeat(100)}`;

    it.each([
      ['hide', makeInputs()],
      ['done', makeInputs({ phase: 'failed', error: LONG_TOKEN_ERROR })]
    ])('pins an uncapped %s button in the shared flow footer', (name, inputs) => {
      mockRowState = { row: makeRow(inputs), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('w-full', 'max-w-none');
      expect(button.closest('[data-flow-footer]')).not.toBeNull();
    });

    it('wraps a failure message with an unbreakable token inside the body', () => {
      mockRowState = { row: makeRow(makeInputs({ phase: 'failed', error: LONG_TOKEN_ERROR })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      const message = screen.getByTestId('bridge-deposit-processing-description');
      expect(message).toHaveTextContent(LONG_TOKEN_ERROR);
      // Only `anywhere` lowers the min-content width the centred column sizes this line to.
      expect(message).toHaveClass('w-full', 'wrap-anywhere', 'select-text');
      expect(message.closest('[data-home-pane-body="true"]')).toHaveClass('overflow-x-hidden');
    });

    it('closes from the header while the deposit is in flight', () => {
      mockRowState = { row: makeRow(makeInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      fireEvent.click(screen.getByRole('button', { name: 'close' }));
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it('moves to the success layout once the deposit is submitted', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('success-layout')).toHaveTextContent('bridgeDepositSubmitted');
    // The same slate as the processing body: one bridge, one colour, either side of submission.
    expect(screen.getByTestId('summary-badge')).toHaveAttribute('data-arrow-fill', '#777487');
    expect(screen.getByTestId('success-footer')).toHaveTextContent('bridgeDepositDeliveryDescription');
  });

  describe('USDCx (Circle xReserve) route', () => {
    const DEPOSIT_HASH = `0x${'c'.repeat(64)}`;
    const usdcxInputs = (overrides: Partial<IBridgedReceiveExtraInputs> = {}) =>
      makeInputs({
        provider: 'usdcx',
        outputAmount: '12.5',
        outputSymbol: 'USDCx',
        phase: 'delivering',
        evmTxHash: DEPOSIT_HASH,
        ...overrides
      });

    it('labels the route USDCx', () => {
      mockRowState = { row: makeRow(usdcxInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('usdcxRouteName · Sepolia → Miden');
    });

    it('uses the recorded Arc source chain for the route and explorer', () => {
      mockRowState = { row: makeRow(usdcxInputs({ sourceChainId: 5042002 })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);
      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('usdcxRouteName · Arc Testnet → Miden');
      fireEvent.click(screen.getByText('viewOnBlockExplorer'));
      expect(openExternalUrl).toHaveBeenCalledWith({
        url: `https://explorer.testnet.arc.io/tx/${DEPOSIT_HASH}`,
        title: 'Arc Testnet'
      });
    });

    it('offers no explorer for a source chain the wallet knows no explorer for', () => {
      mockRowState = { row: makeRow(usdcxInputs({ sourceChainId: NO_EXPLORER_CHAIN.id })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('usdcxRouteName · No Explorer → Miden');
      expect(screen.queryByText('viewOnBlockExplorer')).not.toBeInTheDocument();
    });

    // The app-root watcher writes the phase; the screen reads the row and polls nothing.
    it('waits for the attestation while the row is delivering', () => {
      mockRowState = { row: makeRow(usdcxInputs()), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('delivering');
      expect(screen.getByTestId('success-footer')).toHaveTextContent('usdcxAwaitingAttestation');
    });

    // An executor-route row (Base Sepolia) hands its in-flight copy to the Arc-leg component, which
    // explains each step and offers the execute; the layout's own footer stands down.
    it('shows the Arc leg for an executor-route row while it is delivering', () => {
      mockRowState = {
        row: makeRow(
          usdcxInputs({ sourceChainId: 84532, cctp: { sourceDomain: 6, message: '0x12', attestation: '0xab' } })
        ),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('usdcxRouteName · Base Sepolia → Miden');
      expect(screen.getByTestId('success-footer')).toHaveTextContent('');
      const action = screen.getByTestId('usdcx-execute-action');
      expect(action).toHaveAttribute('data-source-chain', '84532');
      expect(action).toHaveTextContent('delivering:leg');
    });

    it('keeps the direct route copy for an Arc row', () => {
      mockRowState = { row: makeRow(usdcxInputs({ sourceChainId: 5042002 })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('success-footer')).toHaveTextContent('usdcxAwaitingAttestation');
    });

    it('reads Confirmed once the attestation moved the row to ready', () => {
      mockRowState = { row: makeRow(usdcxInputs({ phase: 'ready' })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('confirmed');
      expect(screen.getByTestId('success-footer')).toHaveTextContent('usdcxAttested');
    });

    it('reads Completed once the minted note is received', () => {
      mockRowState = { row: makeRow(usdcxInputs({ phase: 'received' })), loaded: true };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('receipt-rows')).toHaveTextContent('completed');
      expect(screen.getByTestId('success-footer')).toHaveTextContent('usdcxReceived');
    });
  });

  const submittedPhases: IBridgedReceivePhase[] = ['submitting', 'failed', 'delivering', 'received'];

  // The deposit is what the wallet signed for, so it never reads less than left the account: 10.6512 reads 10.66,
  // where down and half-up both read 10.65.
  it.each(submittedPhases)('rounds a long Fast deposit up in the %s state instead of showing every digit', phase => {
    mockRowState = { row: makeRow(makeInputs({ phase, sourceAmount: '10.6512' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    const badge = screen.getByTestId('summary-badge');
    expect(badge.textContent).toMatch(/^10\.66 USDC → /);
    expect(badge).not.toHaveTextContent('10.6512');
  });

  it('expands the decimals of a tiny amount instead of showing zero', () => {
    mockRowState = { row: makeRow(makeInputs({ phase: 'delivering', sourceAmount: '0.000001234' })), loaded: true };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge')).toHaveTextContent('0.0000013 USDC');
  });

  it('shows the credited amount once received, never the quote', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received', outputAmount: '150.2', outputSymbol: 'USDC' }), {
        amount: 150_123_456n
      }),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 USDC → 150.12 USDC');
  });

  // 12.345 reads 12.34 rounded down and 12.35 rounded up, so only the exact stored amount passes.
  it.each([
    ['12.00', '12'],
    ['12.345', '12.345']
  ])(
    'shows the stored "you receive" amount %s while in flight as %s, unpadded and unrounded',
    (outputAmount, shown) => {
      mockRowState = {
        row: makeRow(makeInputs({ phase: 'delivering', outputAmount, outputSymbol: 'USDC' })),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe(`12.5 USDC → ${shown} USDC`);
    }
  );

  it('names the asset without a number once received when the delivered faucet has no known scale', () => {
    mockRowState = {
      row: makeRow(makeInputs({ phase: 'received', outputAmount: '150.2', outputSymbol: 'USDC' }), {
        amount: 150_123_456n,
        faucetId: 'unresolved-faucet'
      }),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 USDC → USDC');
  });

  it('keeps six decimals of a credited ETH amount', () => {
    mockAssetsMetadata = { 'miden-eth': { symbol: 'ETH', name: 'Ether', decimals: 18 } };
    mockRowState = {
      row: makeRow(
        makeInputs({
          provider: 'agglayer',
          sourceAmount: '0.015',
          sourceSymbol: 'ETH',
          outputAmount: '0.015',
          outputSymbol: 'ETH',
          phase: 'received'
        }),
        { amount: 15_123_456_789_000_000n, faucetId: 'miden-eth' }
      ),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('0.015 ETH → 0.015123 ETH');
  });

  it('shows a Slow amount as typed, without a trailing separator', () => {
    mockRowState = {
      row: makeRow(
        makeInputs({
          provider: 'agglayer',
          sourceAmount: '1.',
          sourceSymbol: 'ETH',
          outputAmount: '1.',
          outputSymbol: 'ETH',
          phase: 'delivering'
        })
      ),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('1 ETH → 1 ETH');
  });

  // Past ETH's six decimals: 0.0151235 reads 0.015123 rounded down and 0.015124 rounded up.
  it('shows the Slow route amounts as typed, not rounded at the asset precision', () => {
    mockRowState = {
      row: makeRow(
        makeInputs({
          provider: 'agglayer',
          sourceAmount: '0.0151235',
          sourceSymbol: 'ETH',
          outputAmount: '0.0151235',
          outputSymbol: 'ETH',
          phase: 'delivering'
        })
      ),
      loaded: true
    };
    render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

    expect(screen.getByTestId('summary-badge').textContent).toBe('0.0151235 ETH → 0.0151235 ETH');
  });

  describe('testnet bridge USDC label', () => {
    beforeEach(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      mockAssetsMetadata = { [TEST_MIDEN_USDC_FAUCET]: { symbol: 'USDC', name: 'USDC', decimals: 6 } };
    });

    it('names both sides of a Fast deposit by the testnet label in flight', () => {
      mockRowState = {
        row: makeRow(makeInputs({ phase: 'delivering', outputAmount: '12', outputSymbol: 'USDC' }), {
          faucetId: TEST_MIDEN_USDC_FAUCET
        }),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 Test Epoch USDC → 12 Test Epoch USDC');
    });

    it('names both sides of a Fast deposit by the testnet label once received', () => {
      mockRowState = {
        row: makeRow(makeInputs({ phase: 'received', outputAmount: '150.2', outputSymbol: 'USDC' }), {
          faucetId: TEST_MIDEN_USDC_FAUCET,
          amount: 150_123_456n
        }),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 Test Epoch USDC → 150.12 Test Epoch USDC');
    });

    it('names a USDC source by the testnet label while the token read has not succeeded', () => {
      mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null };
      mockRowState = {
        row: makeRow(makeInputs({ phase: 'delivering', outputAmount: '12', outputSymbol: 'USDC' }), {
          faucetId: TEST_MIDEN_USDC_FAUCET
        }),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 Test Epoch USDC → 12 Test Epoch USDC');
    });

    it('names the source of a Slow USDC deposit by the testnet label, as its Review did', () => {
      mockRowState = {
        row: makeRow(
          makeInputs({
            provider: 'agglayer',
            sourceAmount: '12.5',
            sourceSymbol: 'USDC',
            outputAmount: '12.5',
            outputSymbol: 'USDC',
            phase: 'delivering'
          }),
          { faucetId: '' }
        ),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe('12.5 Test Epoch USDC → 12.5 USDC');
    });

    it('names a Slow ERC-20 deposit by its own symbol', () => {
      mockRowState = {
        row: makeRow(
          makeInputs({
            provider: 'agglayer',
            sourceAmount: '1.5',
            sourceSymbol: 'WBTC',
            outputAmount: '1.5',
            outputSymbol: 'WBTC',
            phase: 'delivering',
            agglayerDelivery: { originToken: '0x00000000000000000000000000000000000000d1' }
          }),
          { faucetId: '' }
        ),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe('1.5 WBTC → 1.5 WBTC');
    });

    it('keeps a Slow ETH deposit on ETH', () => {
      mockRowState = {
        row: makeRow(
          makeInputs({
            provider: 'agglayer',
            sourceAmount: '0.015',
            sourceSymbol: 'ETH',
            outputAmount: '0.015',
            outputSymbol: 'ETH',
            phase: 'delivering'
          }),
          { faucetId: '' }
        ),
        loaded: true
      };
      render(<EvmBridgeDepositStatus txId="bridge-1" onDone={onDone} />);

      expect(screen.getByTestId('summary-badge').textContent).toBe('0.015 ETH → 0.015 ETH');
    });
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

describe('user-visible watched bridge failures', () => {
  const show = (phase: IBridgedReceivePhase, error?: string, id = 'bridge-1') => {
    mockRowState = { loaded: true, row: makeRow(makeInputs({ phase, error }), { id }) };
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockTranslatedFallback = true;
    jest.useFakeTimers();
    mockRowState = { loaded: false };
  });
  afterEach(() => {
    jest.useRealTimers();
    mockTranslatedFallback = false;
  });

  it.each([
    [
      'raw reason',
      'private deposit 42 https://synthetic.invalid/0xabc',
      'private deposit 42 https://synthetic.invalid/0xabc',
      'raw_bridge_deposit_failed'
    ],
    ['empty reason', '', 'Visible generic bridge failure', 'transactionErrorDescription'],
    ['generic fallback', undefined, 'Visible generic bridge failure', 'transactionErrorDescription']
  ])('reports an observed live failure with %s once', async (_label, error, copy, id) => {
    show('submitting');
    const view = render(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    show('failed', error);
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveTextContent(copy!);
    await expectErrorAfterDwell(id!, 'status_screen');
  });

  it('keeps the same raw failure episode when only its displayed details change', async () => {
    show('submitting');
    const view = render(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    show('failed', 'private first reason');
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    show('failed', 'private updated reason');
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    expect(screen.getByText('private updated reason')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(499);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_bridge_deposit_failed', 'status_screen']]);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_bridge_deposit_failed', 'status_screen']]);
  });

  it.each(['already failed', 'first loaded', 'reopened', 'selected row changed'])(
    'keeps the %s persisted failure quiet',
    async scenario => {
      if (scenario !== 'first loaded')
        show(scenario === 'selected row changed' ? 'submitting' : 'failed', 'past failure');
      const view = render(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
      if (scenario === 'reopened') {
        view.unmount();
        render(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
      } else {
        const nextId = scenario === 'selected row changed' ? 'bridge-2' : 'bridge-1';
        show('failed', 'past failure', nextId);
        view.rerender(<EvmBridgeDepositStatus txId={nextId} onDone={jest.fn()} />);
      }
      expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveTextContent('past failure');
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(mockReportUserVisibleError.mock.calls).toEqual([]);
    }
  );

  it.each(['recover', 'unmount', 'row change'])('cancels a watched failure on %s before dwell', async action => {
    show('submitting');
    const view = render(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    show('failed', 'short failure');
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (action === 'unmount') view.unmount();
    else {
      const nextId = action === 'row change' ? 'bridge-2' : 'bridge-1';
      show('submitting', undefined, nextId);
      view.rerender(<EvmBridgeDepositStatus txId={nextId} onDone={jest.fn()} />);
    }
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('short failure')).not.toBeInTheDocument();
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps loading, signing and the next-confirmation wait quiet', async () => {
    const view = render(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    show('submitting');
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} awaitingNextConfirmation />);
    expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveAttribute('role', 'status');
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    show('delivering');
    view.rerender(<EvmBridgeDepositStatus txId="bridge-1" onDone={jest.fn()} />);
    expect(screen.getByTestId('success-layout')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});
