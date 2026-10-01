import React from 'react';

import { render, screen } from '@testing-library/react';

import { TOKEN_IETH } from 'lib/miden/swap/tokens';
import { WalletStatus } from 'lib/shared/types';
import type { WalletStore } from 'lib/store/types';
import { WalletType } from 'screens/onboarding/types';

import { reachesSeedBackupThreshold, SeedBackupGate } from './SeedBackupGate';

type GateState = Pick<
  WalletStore,
  'status' | 'seedPhraseStatus' | 'ownMnemonic' | 'accounts' | 'balances' | 'tokenPrices'
>;
let mockState: GateState;
let mockRequired = false;
let mockCompleted = false;
const mockSave = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: GateState) => T) => selector(mockState)
}));
jest.mock('lib/miden/front/storage', () => ({
  useStorage: (key: string) => {
    if (key === 'seed_backup_required_v1') return [mockRequired, mockSave];
    return [{ prompts: { verifySeedPhrase: mockCompleted ? 'completed' : 'dismissed' } }, mockSave];
  }
}));
jest.mock('lib/wallet-prompts', () => ({
  EMPTY_WALLET_PROMPT_STORAGE: { prompts: {} },
  WALLET_PROMPTS_STORAGE_KEY: 'wallet_prompts_v1',
  WalletPromptType: { VerifySeedPhrase: 'verifySeedPhrase' },
  WalletPromptStatus: { Completed: 'completed' }
}));
jest.mock('app/layouts/FullScreenPage', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));
jest.mock('./VerifySeedPhraseFlow', () => ({
  __esModule: true,
  default: ({ required }: { required: boolean }) => <div data-testid="backup" data-required={required} />
}));

const token = (balance: number) => ({
  tokenId: TOKEN_IETH.faucetId,
  tokenSlug: 'ETH',
  metadata: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  balance,
  fiatPrice: 999999,
  change24h: 0
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRequired = false;
  mockCompleted = false;
  mockState = {
    status: WalletStatus.Ready,
    seedPhraseStatus: 'stored',
    ownMnemonic: false,
    accounts: [{ publicKey: 'a', name: 'Account', isPublic: false, type: WalletType.Guardian, hdIndex: 0 }],
    balances: { a: [token(1)] },
    tokenPrices: { ETH: { price: 150, change24h: 0, percentageChange24h: 0 } }
  };
});

const app = () => (
  <SeedBackupGate>
    <button>Wallet action</button>
  </SeedBackupGate>
);

it.each([149.99, 0])('allows actions below the threshold: %s USD', value => {
  mockState.tokenPrices.ETH = { price: value, change24h: 0, percentageChange24h: 0 };
  render(app());
  expect(screen.getByRole('button')).toBeInTheDocument();
  expect(mockSave).not.toHaveBeenCalled();
});

it.each([150, 150.01])('blocks actions at %s USD and saves the requirement', value => {
  mockState.tokenPrices.ETH = { price: value, change24h: 0, percentageChange24h: 0 };
  render(app());
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getByTestId('backup')).toHaveAttribute('data-required', 'true');
  expect(mockSave).toHaveBeenCalledWith(true);
});

it('adds balances across accounts and does not count removed accounts', () => {
  mockState.accounts.push({ publicKey: 'b', name: 'Second', isPublic: false, type: WalletType.Guardian, hdIndex: 1 });
  mockState.balances = { a: [token(0.5)], b: [token(0.5)], removed: [token(100)] };
  expect(reachesSeedBackupThreshold(mockState)).toBe(true);
  mockState.accounts.pop();
  expect(reachesSeedBackupThreshold(mockState)).toBe(false);
});

it('keeps the saved requirement when prices or balances are missing', () => {
  mockRequired = true;
  mockState.balances = {};
  mockState.tokenPrices = {};
  render(app());
  expect(screen.getByTestId('backup')).toBeInTheDocument();
});

it('unblocks only after the backup check is completed', () => {
  const view = render(app());
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  mockCompleted = true;
  view.rerender(app());
  expect(screen.getByRole('button')).toBeInTheDocument();
});

it('blocks an action screen that is already open when the balance increases', () => {
  mockState.balances.a = [token(0.9)];
  const view = render(app());
  expect(screen.getByRole('button')).toBeInTheDocument();
  mockState.balances.a = [token(1)];
  view.rerender(app());
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('keeps unlock available', () => {
  mockState.status = WalletStatus.Locked;
  render(app());
  expect(screen.getByRole('button')).toBeInTheDocument();
});

it('does not ask to back up an imported phrase or a removed phrase', () => {
  mockState.ownMnemonic = true;
  const view = render(app());
  expect(screen.getByRole('button')).toBeInTheDocument();
  mockState.ownMnemonic = false;
  mockState.seedPhraseStatus = 'removed';
  view.rerender(app());
  expect(screen.getByRole('button')).toBeInTheDocument();
});

it('does not invent a value for an unpriced token or an unresolved scale', () => {
  mockState.tokenPrices = {};
  expect(reachesSeedBackupThreshold(mockState)).toBe(false);
  mockState.tokenPrices = { ETH: { price: 150, change24h: 0, percentageChange24h: 0 } };
  mockState.balances.a = [{ ...token(1), metadata: { ...token(1).metadata, scaleIsUnknown: true } }];
  expect(reachesSeedBackupThreshold(mockState)).toBe(false);
});

it('ignores invalid balances and prices', () => {
  mockState.balances.a = [token(NaN), token(Infinity), token(-1)];
  expect(reachesSeedBackupThreshold(mockState)).toBe(false);
  mockState.balances.a = [token(1)];
  mockState.tokenPrices.ETH = { price: Infinity, change24h: 0, percentageChange24h: 0 };
  expect(reachesSeedBackupThreshold(mockState)).toBe(false);
});

it('keeps the gate closed if the requirement write fails and the balance then falls', async () => {
  mockSave.mockRejectedValueOnce(new Error('storage failed'));
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const view = render(app());
    await Promise.resolve();
    mockState.balances = {};
    view.rerender(app());
    expect(screen.getByTestId('backup')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  } finally {
    warning.mockRestore();
  }
});
