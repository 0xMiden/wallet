import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import type { WalletPaymentLink } from 'lib/one-click/payment-links';

import { DepositQrSheet } from './DepositQrSheet';
import { DepositRouteSheet, type DepositRouteOption } from './DepositRouteSheet';
import { OpenWalletSheet } from './OpenWalletSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children, overlayClassName }: { children: React.ReactNode; overlayClassName?: string }) => (
    <div data-testid="drawer-content" data-overlay={overlayClassName}>
      {children}
    </div>
  ),
  DrawerTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  )
}));
jest.mock('components/QRCode', () => ({
  QRCode: ({ address }: { address: string }) => <span data-testid="qr" data-value={address} />
}));

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('DepositQrSheet', () => {
  it('shows the real QR of the value under "Scan to send", with the default note', () => {
    render(<DepositQrSheet open onOpenChange={jest.fn()} value="0xabc" />);
    expect(screen.getByRole('heading', { name: 'depositFlowScanToSend' })).toHaveClass('text-[28px]');
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', '0xabc');
    expect(screen.getByText('depositFlowScanNote')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-content')).toHaveAttribute('data-overlay', 'bg-pure-black/40');
  });

  it('takes a note and closes from the close button', () => {
    const onOpenChange = jest.fn();
    render(<DepositQrSheet open onOpenChange={onOpenChange} value="0xabc" note="Other note" />);
    expect(screen.getByText('Other note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('deposit-qr-sheet-close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(hapticLight).toHaveBeenCalled();
  });

  it('draws nothing while closed', () => {
    render(<DepositQrSheet open={false} onOpenChange={jest.fn()} value="0xabc" />);
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
  });
});

const LINKS: WalletPaymentLink[] = [
  { wallet: 'trust', url: 'trust://send?x' },
  { wallet: 'metamask', url: 'metamask://send/x' }
];

describe('OpenWalletSheet', () => {
  it('lists each wallet link with its name and icon, then the note', () => {
    render(<OpenWalletSheet open onOpenChange={jest.fn()} links={LINKS} onOpenWallet={jest.fn()} />);
    expect(screen.getByRole('heading', { name: 'depositFlowOpenIn' })).toBeInTheDocument();
    expect(screen.getByTestId('deposit-open-wallet-trust')).toHaveTextContent('paymentWalletTrust');
    expect(screen.getByTestId('deposit-open-wallet-metamask')).toHaveTextContent('paymentWalletMetamask');
    expect(screen.getByTestId('deposit-open-wallet-trust').querySelector('img')).toHaveAttribute('src');
    expect(screen.getByText('depositFlowOpenInNote')).toBeInTheDocument();
  });

  it('opens the tapped link and blocks the other rows until it settles', async () => {
    let settle: (opened: boolean) => void = () => {};
    const onOpenWallet = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          settle = resolve;
        })
    );
    render(<OpenWalletSheet open onOpenChange={jest.fn()} links={LINKS} onOpenWallet={onOpenWallet} />);
    fireEvent.click(screen.getByTestId('deposit-open-wallet-metamask'));
    expect(onOpenWallet).toHaveBeenCalledWith(LINKS[1]);
    expect(screen.getByTestId('deposit-open-wallet-trust')).toBeDisabled();
    expect(screen.getByTestId('deposit-open-wallet-metamask')).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByTestId('deposit-open-wallet-trust'));
    expect(onOpenWallet).toHaveBeenCalledTimes(1);
    await act(async () => settle(true));
    expect(screen.getByTestId('deposit-open-wallet-trust')).toBeEnabled();
    expect(screen.queryByTestId('deposit-open-wallet-failed')).not.toBeInTheDocument();
  });

  it('says so when the wallet does not open or the call fails', async () => {
    const onOpenWallet = jest.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('no app'));
    render(<OpenWalletSheet open onOpenChange={jest.fn()} links={LINKS} onOpenWallet={onOpenWallet} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-open-wallet-trust'));
    });
    expect(screen.getByTestId('deposit-open-wallet-failed')).toHaveTextContent('depositWalletOpenFailed');
    await act(async () => {
      fireEvent.click(screen.getByTestId('deposit-open-wallet-metamask'));
    });
    expect(screen.getByTestId('deposit-open-wallet-failed')).toBeInTheDocument();
  });
});

const ROUTES: DepositRouteOption[] = [
  {
    id: 'agglayer',
    name: 'Agglayer',
    arrivesIn: 'About 30 minutes',
    received: { amount: '70.25' },
    fee: { kind: 'none' },
    best: true,
    fastest: false,
    selected: false
  },
  {
    id: 'epoch',
    name: 'Epoch',
    arrivesIn: 'About 2 minutes',
    received: { amount: '70.04' },
    fee: { kind: 'amount', value: { amount: 210000n, decimals: 6 } },
    best: false,
    fastest: true,
    selected: true
  }
];

describe('DepositRouteSheet', () => {
  it('shows each route with what arrives, its fee, its time, its tags and the chosen mark', () => {
    render(
      <DepositRouteSheet
        open
        onOpenChange={jest.fn()}
        routes={ROUTES}
        receivedSymbol="USDCx"
        feeSymbol="USDC"
        onSelect={jest.fn()}
      />
    );
    expect(screen.getByRole('heading', { name: 'depositFlowChooseRoute' })).toBeInTheDocument();
    const agglayer = screen.getByTestId('deposit-route-agglayer');
    const epoch = screen.getByTestId('deposit-route-epoch');
    expect(agglayer).toHaveTextContent('70.25 USDCx');
    expect(agglayer).toHaveTextContent('depositFlowNoFee');
    expect(agglayer).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('deposit-route-agglayer-best')).toHaveTextContent('depositFlowMostReceived');
    expect(epoch).toHaveTextContent('depositFlowRouteFee {"fee":"0.21 USDC"}');
    expect(epoch).toHaveTextContent('About 2 minutes');
    expect(epoch).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('deposit-route-epoch-fastest')).toHaveTextContent('depositFlowFastest');
  });

  it('leads with the fee before an amount, and shows how much less an untagged route delivers', () => {
    const routes: DepositRouteOption[] = [
      {
        id: 'a',
        name: 'A',
        arrivesIn: 'Soon',
        fee: { kind: 'rate', text: '0.3%' },
        best: false,
        fastest: false,
        selected: false
      },
      {
        id: 'b',
        name: 'B',
        arrivesIn: 'Later',
        received: { amount: '9' },
        less: { amount: '1' },
        best: false,
        fastest: false,
        selected: false
      }
    ];
    render(
      <DepositRouteSheet
        open
        onOpenChange={jest.fn()}
        routes={routes}
        receivedSymbol="ETH"
        feeSymbol="ETH"
        onSelect={jest.fn()}
      />
    );
    expect(screen.getByTestId('deposit-route-a')).toHaveTextContent('depositFlowRouteFee {"fee":"0.3%"}');
    expect(screen.getByTestId('deposit-route-b')).toHaveTextContent('depositFlowRouteLess {"amount":"1 ETH"}');
  });

  it('reports the chosen route with the selection haptic', () => {
    const onSelect = jest.fn();
    render(
      <DepositRouteSheet
        open
        onOpenChange={jest.fn()}
        routes={ROUTES}
        receivedSymbol="USDCx"
        feeSymbol="USDC"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByTestId('deposit-route-agglayer'));
    expect(onSelect).toHaveBeenCalledWith('agglayer');
    expect(hapticSelection).toHaveBeenCalledTimes(1);
  });
});
