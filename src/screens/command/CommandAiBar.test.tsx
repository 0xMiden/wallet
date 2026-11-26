import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { generateMnemonic } from '@miden/hd-key';
import type { BridgeRoute } from 'lib/bridge/core/routes';
import { CommandAiClientError, compileCommandPrompt } from 'lib/command-ai/client';
import { containsCommandSecret } from 'lib/command-ai/help';
import { executeLocalLedgerQuery } from 'lib/command-ai/local-query';
import type { AiCompilerOutput } from 'lib/command-ai/schema';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { _setSwapTokensForTest } from 'lib/miden/swap/tokens';
import { WalletStatus, type WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import { CommandAiPlanBanner, CommandAiPlanProvider } from './command-ai-plan';
import { CommandDraftProvider, useCommandDrafts } from './command-drafts';
import type { CommandRoute } from './command-routes';
import { CommandAiBar } from './CommandAiBar';
import { CommandPortfolio } from './CommandPortfolio';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key} ${Object.values(values).join(' ')}` : key)
  })
}));

jest.mock('lib/telemetry/use-user-visible-error', () => ({ useUserVisibleError: jest.fn() }));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  createLocationState: () => ({ historyPosition: 1, href: '/' }),
  listen: () => () => {}
}));

jest.mock('lib/command-ai/client', () => {
  const actual = jest.requireActual<typeof import('lib/command-ai/client')>('lib/command-ai/client');
  return {
    ...actual,
    compileCommandPrompt: jest.fn()
  };
});

jest.mock('lib/command-ai/local-query', () => {
  const actual = jest.requireActual<typeof import('lib/command-ai/local-query')>('lib/command-ai/local-query');
  return {
    ...actual,
    executeLocalLedgerQuery: jest.fn()
  };
});

let mockBridgeRoutes: Pick<BridgeRoute, 'id' | 'provider' | 'mode' | 'source' | 'destination'>[] | undefined;

jest.mock('lib/bridge/catalog', () => ({
  deriveBridgeRoutes: () =>
    mockBridgeRoutes ?? [
      {
        id: 'testnet:epoch:usdc:faucet-usdcx:receive',
        provider: 'epoch',
        mode: 'receive',
        source: { kind: 'erc20', network: 'sepolia', symbol: 'USDC', decimals: 6, address: '0x1' },
        destination: { kind: 'miden', network: 'miden-testnet', symbol: 'USDCx', decimals: 6, faucetId: 'faucet-usdcx' }
      },
      {
        id: 'testnet:agglayer:usdc:faucet-usdcx:receive',
        provider: 'agglayer',
        mode: 'receive',
        source: { kind: 'erc20', network: 'sepolia', symbol: 'USDC', decimals: 6, address: '0x1' },
        destination: { kind: 'miden', network: 'miden-testnet', symbol: 'USDCx', decimals: 6, faucetId: 'faucet-usdcx' }
      },
      {
        id: 'testnet:xreserve:usdc:faucet-usdcx:receive',
        provider: 'xreserve',
        mode: 'receive',
        source: { kind: 'erc20', network: 'sepolia', symbol: 'USDC', decimals: 6, address: '0x1' },
        destination: { kind: 'miden', network: 'miden-testnet', symbol: 'USDCx', decimals: 6, faucetId: 'faucet-usdcx' }
      }
    ]
}));

let mockEarnVaultCatalog: unknown[] | null = null;
let mockMidenUsdcFaucetId: string | null = null;

jest.mock('lib/remote-config/values', () => {
  const actual = jest.requireActual<typeof import('lib/remote-config/values')>('lib/remote-config/values');
  return {
    ...actual,
    selectEarnVaultCatalog: (...args: Parameters<typeof actual.selectEarnVaultCatalog>) =>
      mockEarnVaultCatalog ?? actual.selectEarnVaultCatalog(...args),
    selectMidenUsdcFaucetId: (...args: Parameters<typeof actual.selectMidenUsdcFaucetId>) =>
      mockMidenUsdcFaucetId ?? actual.selectMidenUsdcFaucetId(...args)
  };
});

jest.mock('lib/miden/portfolio-observations', () => ({
  recordPortfolioObservation: jest.fn().mockResolvedValue(undefined),
  readPortfolioObservations: jest.fn().mockResolvedValue([])
}));

jest.mock('components/TokenLogo', () => ({ TokenLogo: () => <span aria-hidden="true" /> }));
jest.mock('lib/miden/front/storage', () => ({
  useStorage: () => [true, jest.fn()]
}));
jest.mock('./useCommandPortfolio', () => ({
  useCommandPortfolio: () => ({
    assets: [],
    allocation: [],
    tokenPrices: {},
    value: '0',
    priceMovement24h: null,
    coverage: 'complete',
    coverageKey: 'priced:',
    capturedAt: Date.now(),
    current: true,
    empty: true,
    canRecord: false
  })
}));

const ALICE_ADDR = 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62';
const ALICE_WORK_ADDR = '0x023230000000000000000000000000000000a9f1';
const scope = { accountId: 'mtst1me000000000000000000000000000000', network: 'testnet', rpcUrl: 'https://rpc.test' };

const assets: TokenBalanceData[] = [
  {
    tokenId: 'faucet-miden',
    tokenSlug: 'MIDEN',
    balance: 25,
    balanceBaseUnits: '25000000',
    fiatPrice: 2,
    change24h: 0,
    metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6 }
  },
  {
    tokenId: 'faucet-usdcx',
    tokenSlug: 'USDCx',
    balance: 1000,
    balanceBaseUnits: '1000000000',
    fiatPrice: 1,
    change24h: 0,
    metadata: { symbol: 'USDCx', name: 'USDCx', decimals: 6 }
  }
];

jest.mock('utils/miden', () => {
  const actual = jest.requireActual<typeof import('utils/miden')>('utils/miden');
  return {
    ...actual,
    isValidMidenAddress: (addr: string) => {
      if (addr.startsWith('mtst1') && addr.length > 20) return true;
      throw new actual.MidenAddressError('invalid');
    },
    isValidEthereumAddress: (addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr)
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockBridgeRoutes = undefined;
  mockEarnVaultCatalog = null;
  mockMidenUsdcFaucetId = null;
  const account: WalletAccount = {
    publicKey: scope.accountId,
    name: 'Main',
    type: WalletType.OnChain,
    isPublic: true,
    hdIndex: 0,
    authScheme: 'falcon'
  };
  useWalletStore.setState({
    status: WalletStatus.Ready,
    currentAccount: account,
    accounts: [account],
    settings: {
      contacts: [
        { name: 'Alice', address: ALICE_ADDR },
        { name: 'Alice Work', address: ALICE_WORK_ADDR }
      ]
    }
  });
});

function renderBar(route: CommandRoute = { kind: 'dashboard' }) {
  let readDraft!: ReturnType<typeof useCommandDrafts>['readDraft'];
  function Probe() {
    readDraft = useCommandDrafts().readDraft;
    return (
      <>
        <CommandAiPlanBanner scope={scope} route={route} />
        <CommandAiBar scope={scope} assets={assets} tokenPrices={{}} />
      </>
    );
  }
  const view = render(
    <CommandDraftProvider scope={scope}>
      <CommandAiPlanProvider scope={scope}>
        <Probe />
      </CommandAiPlanProvider>
    </CommandDraftProvider>
  );
  return { ...view, readDraft: () => readDraft };
}

describe('CommandAiBar', () => {
  describe('review regression', () => {
    beforeEach(() => {
      jest.mocked(compileCommandPrompt).mockReset();
      jest.mocked(executeLocalLedgerQuery).mockReset();
    });

    const bridgeIntent: AiCompilerOutput = {
      op: 'set_intent',
      action: 'bridge',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'USDC',
      to_asset: null,
      from_chain: null,
      to_chain: 'miden',
      recipient_ref: null,
      provider: null,
      note_type: null,
      earn_op: null
    };

    function submit(value: string) {
      const input = screen.getByTestId('command-ai-input');
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest('form')!);
      return input;
    }

    async function openClarification() {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce(bridgeIntent);
      submit('bridge 500 usdc to miden');
      return screen.findByTestId('command-ai-clarification');
    }

    it.each(['sentence', 'quoted', 'wallet export'] as const)(
      'blocks %s secrets before calling the compiler',
      async shape => {
        const mnemonic = generateMnemonic();
        const sample = {
          sentence: 'Please explain how to restore ' + mnemonic,
          quoted: 'My backup is [' + mnemonic + ']',
          'wallet export': 'I copied ' + 'ab'.repeat(32) + ':' + '01'.repeat(32)
        }[shape];
        renderBar();
        await act(async () => {
          submit(sample);
        });
        expect(jest.mocked(compileCommandPrompt).mock.calls.length).toBe(0);
        expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiHelpSecret');
        expect(screen.getByTestId('command-ai-input')).toHaveValue('');
      }
    );

    it('blocks a private-key pair split by a line break', async () => {
      const first = 'ab'.repeat(32);
      const second = '01'.repeat(32);
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Recovery',
        answer: 'General recovery information.'
      });
      renderBar();
      fireEvent.click(screen.getByTestId('command-ai-morph-toggle'));
      const input = screen.getByTestId('command-ai-input');
      expect(input.tagName).toBe('TEXTAREA');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'I copied ' + first + '\n:\n' + second } });
        expect(input).toHaveValue('I copied ' + first + '\n:\n' + second);
        fireEvent.submit(input.closest('form')!);
      });
      expect(jest.mocked(compileCommandPrompt).mock.calls.length).toBe(0);
      expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiHelpSecret');
      expect(input).toHaveValue('');
      expect(document.body.textContent).not.toContain(first);
      expect(document.body.textContent).not.toContain(second);
      expect(containsCommandSecret('I copied 0x' + first + '\r\n:\r\n0x' + second)).toBe(true);
    });

    it('sends an exact-length hex token as a placeholder', async () => {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Notes',
        answer: 'A note can carry a payment.'
      });
      renderBar();
      submit('What is note ' + 'ab'.repeat(32) + '?');
      expect(jest.mocked(compileCommandPrompt)).toHaveBeenCalledTimes(1);
      expect(jest.mocked(compileCommandPrompt)).toHaveBeenCalledWith({
        redactedText: 'What is note <ADDR_1>?',
        helpContext: null,
        signal: expect.any(AbortSignal)
      });
      expect(await screen.findByTestId('command-ai-help-answer')).toHaveTextContent('commandAiHelpNotesTitle');
    });

    it('screens a labelled secret after a lead-in', async () => {
      const sample = 'example-placeholder';
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Safety',
        answer: 'Keep wallet credentials private.'
      });
      renderBar();
      await act(async () => {
        submit('Hello, my password is ' + sample);
      });
      expect(jest.mocked(compileCommandPrompt).mock.calls.length).toBe(0);
      expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiHelpSecret');
      expect(screen.getByTestId('command-ai-input')).toHaveValue('');
      expect(document.body.textContent).not.toContain(sample);
    });

    it('keeps full labelled values blocked even if they begin with a troubleshooting word', () => {
      expect(containsCommandSecret('My password is lost example-placeholder')).toBe(true);
      expect(containsCommandSecret('password: lost')).toBe(true);
    });

    it.each([
      ['password', '.'],
      ['private key', ','],
      ['recovery phrase', ';'],
      ['seed phrase', ':']
    ])('blocks a later %s declaration in the same line', async (label, boundary) => {
      const placeholder = 'example-placeholder';
      renderBar();
      await act(async () => {
        submit('My seed phrase is stolen' + boundary + ' ' + label + ' is ' + placeholder);
      });
      expect(compileCommandPrompt).not.toHaveBeenCalled();
      expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiHelpSecret');
      expect(screen.getByTestId('command-ai-input')).toHaveValue('');
      expect(document.body.textContent).not.toContain(placeholder);
    });

    it('rejects oversized composer text and preserves it for editing', async () => {
      const draft = 'help '.repeat(400) + '?';
      renderBar();
      await act(async () => {
        submit(draft);
      });
      expect(compileCommandPrompt).not.toHaveBeenCalled();
      expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiInputTooLong');
      expect(screen.getByTestId('command-ai-input')).toHaveValue(draft);
    });

    it('characterizes the local secret branches', () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----';
      expect(containsCommandSecret(pem)).toBe(true);
      expect(containsCommandSecret('password: example-placeholder')).toBe(true);
      expect(containsCommandSecret('seed phrase=example-placeholder')).toBe(true);
      expect(containsCommandSecret('ab'.repeat(32))).toBe(true);
      expect(containsCommandSecret('note ' + 'ab'.repeat(33) + ' pending')).toBe(true);
      expect(containsCommandSecret('ab'.repeat(33) + 'a')).toBe(false);
      expect(containsCommandSecret('note ' + 'ab'.repeat(32) + ' pending')).toBe(false);
    });

    it.each([
      ['password', 'My password is not working'],
      ['private-key', 'My private key is lost'],
      ['recovery-phrase', 'My recovery phrase is not working'],
      ['conditional password', 'What happens if my password is wrong?'],
      ['conditional recovery-phrase', 'What if my seed phrase is stolen?'],
      ['conditional private-key', 'What should I do if my private key is compromised?']
    ])('keeps %s troubleshooting eligible for help', async (_label, prompt) => {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Recovery',
        answer: 'Check your recovery options without sharing credentials.'
      });
      renderBar();
      await act(async () => {
        submit(prompt);
      });
      expect(jest.mocked(compileCommandPrompt)).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('command-ai-help-answer')).toHaveTextContent('commandAiHelpRecoveryTitle');
    });

    it('keeps ordinary recovery questions eligible for help', async () => {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Recovery',
        answer: 'A current backup may help you restore account data.'
      });
      renderBar();
      submit('My recovery phrase is missing. Can I recover my wallet?');
      expect(jest.mocked(compileCommandPrompt).mock.calls.length).toBe(1);
      expect(await screen.findByTestId('command-ai-help-answer')).toHaveTextContent('commandAiHelpRecoveryTitle');
    });

    it.each<AiCompilerOutput>([
      { op: 'unsupported', reason: 'An unanswered slot needs context', suggested_route: null },
      { op: 'cancel' },
      {
        op: 'query_ledger',
        query: 'balance',
        asset: null,
        counterparty_ref: null,
        direction: 'all',
        window: 'all_time'
      }
    ])('recompiles a clarification reply after a first-pass $op', async first => {
      renderBar();
      await openClarification();
      jest
        .mocked(compileCommandPrompt)
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce({
          op: 'patch_slots',
          patch: {
            action: null,
            amount: null,
            asset: null,
            to_asset: null,
            from_chain: null,
            to_chain: null,
            recipient_ref: null,
            provider: 'agglayer',
            note_type: null,
            earn_op: null
          }
        });

      submit('agglayer');

      await waitFor(() => expect(compileCommandPrompt).toHaveBeenCalledTimes(3));
      expect(compileCommandPrompt).toHaveBeenNthCalledWith(2, {
        redactedText: 'agglayer',
        helpContext: null,
        signal: expect.any(AbortSignal)
      });
      expect(compileCommandPrompt).toHaveBeenNthCalledWith(3, {
        redactedText: 'agglayer',
        snapshot: expect.objectContaining({ draft: expect.objectContaining({ action: 'bridge' }) }),
        signal: expect.any(AbortSignal)
      });
      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/bridge/deposit'));
      expect(executeLocalLedgerQuery).not.toHaveBeenCalled();
    });

    it('keeps unsent composer text when opening a topic answer', async () => {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Bridge',
        answer: 'Bridge moves funds between networks.'
      });
      renderBar();
      const input = screen.getByTestId('command-ai-input');
      fireEvent.change(input, { target: { value: 'unfinished action' } });
      fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpBrowse' }));
      fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpBridgeTitle' }));
      await screen.findByTestId('command-ai-help-answer');
      expect(input).toHaveValue('unfinished action');
    });

    it('keeps an edit made while a typed help request is pending', async () => {
      let reply!: (value: AiCompilerOutput) => void;
      jest.mocked(compileCommandPrompt).mockReturnValueOnce(new Promise(resolve => (reply = resolve)));
      renderBar();
      const input = submit('How private is it?');
      fireEvent.change(input, { target: { value: 'another question' } });
      await act(async () => {
        reply({ op: 'explain', topic: 'Privacy', answer: 'Private notes stay off the public chain.' });
      });
      await screen.findByTestId('command-ai-help-answer');
      expect(input).toHaveValue('another question');
    });

    it.each(['dismiss', 'select'] as const)(
      'clears a request error when users %s a clarification',
      async transition => {
        renderBar();
        const clarification = await openClarification();
        jest.mocked(compileCommandPrompt).mockRejectedValueOnce(new CommandAiClientError('unavailable', 'offline'));
        submit('What happens next?');
        expect(await screen.findByTestId('command-ai-error')).toHaveTextContent('commandAiServiceUnavailable');

        const control =
          transition === 'dismiss'
            ? within(clarification).getByRole('button', { name: 'close' })
            : screen.getByTestId('command-ai-chip-testnet:agglayer:usdc:faucet-usdcx:receive');
        fireEvent.click(control);
        expect(jest.mocked(navigate).mock.calls).toEqual(transition === 'select' ? [['/bridge/deposit']] : []);
        expect(screen.queryByTestId('command-ai-error')).not.toBeInTheDocument();
      }
    );

    it('dismisses a request error without discarding a clarification', async () => {
      renderBar();
      await openClarification();
      jest.mocked(compileCommandPrompt).mockRejectedValueOnce(new CommandAiClientError('unavailable', 'offline'));
      submit('What happens next?');
      const error = await screen.findByTestId('command-ai-error');
      fireEvent.click(within(error).getByRole('button', { name: 'close' }));
      expect(screen.queryByTestId('command-ai-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('command-ai-clarification')).toBeInTheDocument();
    });

    it.each(['stop', 'continue'] as const)('clears stale errors when users %s their plan', async button => {
      const { op: _op, ...bridge } = bridgeIntent;
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'set_plan',
        steps: [bridge, { ...bridge, amount: { kind: 'previous_output' } }]
      });
      renderBar();
      submit('bridge 500 usdc to miden twice');
      await screen.findByTestId('command-ai-plan-card');
      fireEvent.click(screen.getByTestId('command-ai-chip-testnet:agglayer:usdc:faucet-usdcx:receive'));
      expect(navigate).toHaveBeenCalledWith('/bridge/deposit');
      jest.mocked(compileCommandPrompt).mockRejectedValueOnce(new CommandAiClientError('unavailable', 'offline'));
      submit('What happens next?');
      expect(await screen.findByTestId('command-ai-error')).toHaveTextContent('commandAiServiceUnavailable');

      fireEvent.click(screen.getByTestId('command-ai-plan-' + button));
      expect(screen.queryByTestId('command-ai-error')).not.toBeInTheDocument();
    });

    it('keeps the active plan visible when a ledger query fails', async () => {
      const { op: _op, ...bridge } = bridgeIntent;
      const query: AiCompilerOutput = {
        op: 'query_ledger',
        query: 'balance',
        asset: null,
        counterparty_ref: null,
        direction: 'all',
        window: 'all_time'
      };
      jest
        .mocked(compileCommandPrompt)
        .mockResolvedValueOnce({ op: 'set_plan', steps: [bridge, { ...bridge, amount: { kind: 'previous_output' } }] })
        .mockResolvedValueOnce(query)
        .mockResolvedValueOnce(query);
      jest
        .mocked(executeLocalLedgerQuery)
        .mockRejectedValueOnce(new Error('synthetic ledger failure'))
        .mockResolvedValueOnce({
          query: 'balance',
          titleKey: 'commandAiQueryBalanceTitle',
          summaryText: '25 MIDEN',
          empty: false,
          rows: []
        });

      renderBar();
      submit('bridge 500 usdc to miden twice');
      await screen.findByTestId('command-ai-plan-card');
      await act(async () => {
        submit('What is my balance?');
      });

      expect(executeLocalLedgerQuery).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiServiceUnavailable');
      expect(screen.getByTestId('command-ai-plan-step-0')).toBeInTheDocument();
      expect(useUserVisibleError).toHaveBeenLastCalledWith('raw_command_ai_failed', 'inline');

      submit('What is my balance?');
      const result = await screen.findByTestId('command-ai-query-result');
      expect(result).toHaveTextContent('25 MIDEN');
      fireEvent.click(within(result).getByRole('button', { name: 'close' }));
      expect(screen.queryByTestId('command-ai-plan-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('command-ai-error')).not.toBeInTheDocument();
    });

    it('preserves the active plan when intent resolution throws', async () => {
      const { op: _op, ...bridge } = bridgeIntent;
      jest
        .mocked(compileCommandPrompt)
        .mockResolvedValueOnce({ op: 'set_plan', steps: [bridge, { ...bridge, amount: { kind: 'previous_output' } }] })
        .mockResolvedValueOnce(bridgeIntent)
        .mockResolvedValueOnce(bridgeIntent);
      renderBar();
      submit('bridge 500 usdc to miden twice');
      await screen.findByTestId('command-ai-plan-card');

      mockEarnVaultCatalog = [{}];
      await act(async () => {
        submit('bridge 500 usdc to miden');
      });
      expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiServiceUnavailable');
      expect(screen.getByTestId('command-ai-plan-step-0')).toBeInTheDocument();

      mockEarnVaultCatalog = null;
      submit('bridge 500 usdc to miden');
      const clarification = await screen.findByTestId('command-ai-clarification');
      fireEvent.click(within(clarification).getByRole('button', { name: 'close' }));
      expect(screen.queryByTestId('command-ai-plan-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('command-ai-error')).not.toBeInTheDocument();
    });

    it('dismisses the new request error without restoring an old resolution error', async () => {
      jest
        .mocked(compileCommandPrompt)
        .mockResolvedValueOnce({ op: 'unsupported', reason: 'Synthetic unsupported request', suggested_route: null })
        .mockRejectedValueOnce(new CommandAiClientError('unavailable', 'offline'));
      renderBar();
      submit('Open another app');
      expect(await screen.findByTestId('command-ai-error')).toHaveTextContent('commandAiUnsupported');

      await act(async () => {
        submit('No other open app');
      });
      const latest = screen.getByTestId('command-ai-error');
      expect(latest).toHaveTextContent('commandAiServiceUnavailable');
      fireEvent.click(within(latest).getByRole('button', { name: 'close' }));
      expect(screen.queryByTestId('command-ai-error')).not.toBeInTheDocument();
    });

    it('paints the help card close glyph with the theme color', async () => {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Privacy',
        answer: 'Private notes stay off the public chain.'
      });
      renderBar();
      submit('How private is it?');
      const answer = await screen.findByTestId('command-ai-help-answer');
      expect(within(answer).getByRole('button', { name: 'close' }).querySelector('svg')).toHaveAttribute(
        'fill',
        'currentColor'
      );
    });

    it('uses the selected next topic as the help context', async () => {
      jest
        .mocked(compileCommandPrompt)
        .mockResolvedValueOnce({
          op: 'explain',
          topic: 'Privacy',
          answer: 'Private notes stay off the public chain.'
        })
        .mockResolvedValueOnce({
          op: 'explain',
          topic: 'Verify',
          answer: 'Check the Public or Private choice before you send.'
        });
      renderBar();
      submit('How private is it?');
      await screen.findByTestId('command-ai-help-answer');
      fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpVerifyTitle' }));
      await waitFor(() =>
        expect(screen.getByTestId('command-ai-help-answer')).toHaveTextContent('commandAiHelpVerifyTitle')
      );
      expect(compileCommandPrompt).toHaveBeenLastCalledWith({
        redactedText: 'commandAiHelpVerifyTitle',
        helpContext: 'Verify',
        signal: expect.any(AbortSignal)
      });
    });

    it('rejects an answer on a different topic than the selected one', async () => {
      jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
        op: 'explain',
        topic: 'Notes',
        answer: 'A note carries a payment.'
      });
      renderBar();
      fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpBrowse' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpBridgeTitle' }));
      });
      expect(compileCommandPrompt).toHaveBeenCalledWith({
        redactedText: 'commandAiHelpBridgeTitle',
        helpContext: 'Bridge',
        signal: expect.any(AbortSignal)
      });
      expect(await screen.findByTestId('command-ai-error')).toHaveTextContent('commandAiInvalidModelOutput');
      expect(screen.getByTestId('command-ai-help-topics')).toBeInTheDocument();
      expect(screen.queryByTestId('command-ai-help-answer')).not.toBeInTheDocument();
    });
  });

  it('keeps obvious secrets out of the compiler', () => {
    renderBar();
    const input = screen.getByTestId('command-ai-input');
    fireEvent.change(input, { target: { value: 'My password is example-placeholder' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByTestId('command-ai-error')).toHaveTextContent('commandAiHelpSecret');
    expect(compileCommandPrompt).not.toHaveBeenCalled();
  });

  it('answers a recovery question without treating it as a pasted secret', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
      op: 'explain',
      topic: 'Recovery',
      answer: 'A current backup may help you restore account data.'
    });
    renderBar();
    const input = screen.getByTestId('command-ai-input');
    fireEvent.change(input, { target: { value: 'What if my recovery phrase is lost?' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByTestId('command-ai-help-answer')).toHaveTextContent('commandAiHelpRecoveryTitle');
    expect(compileCommandPrompt).toHaveBeenCalledTimes(1);
  });

  it('never uses a topic suggestion to start or cancel a wallet action', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValueOnce({ op: 'cancel' });
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpBrowse' }));
    fireEvent.click(screen.getByRole('button', { name: 'commandAiHelpBridgeTitle' }));
    await screen.findByTestId('command-ai-error');
    expect(screen.getByTestId('command-ai-help-topics')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('asks the model for a help topic without sending a pending clarification', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValueOnce({
      op: 'set_intent',
      action: 'bridge',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'USDC',
      to_asset: null,
      from_chain: null,
      to_chain: 'miden',
      recipient_ref: null,
      provider: null,
      note_type: null,
      earn_op: null
    });
    jest
      .mocked(compileCommandPrompt)
      .mockResolvedValueOnce({
        op: 'explain',
        topic: 'Privacy',
        answer: 'A private payment keeps its amount off the public chain.'
      })
      .mockResolvedValueOnce({
        op: 'explain',
        topic: 'Verify',
        answer: 'Check the Public or Private choice before you send.'
      });
    renderBar();
    const input = screen.getByTestId('command-ai-input');
    const submit = (value: string) => {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest('form')!);
    };
    submit('bridge 500 usdc to miden');
    const clarification = await screen.findByTestId('command-ai-clarification');
    submit('How private is it?');
    const answer = await screen.findByTestId('command-ai-help-answer');
    expect(answer).toHaveTextContent('commandAiHelpPrivacyTitle');
    expect(answer).toHaveTextContent('A private payment keeps its amount off the public chain.');
    expect(screen.getByTestId('command-ai-clarification')).toBe(clarification);
    expect(compileCommandPrompt).toHaveBeenCalledTimes(2);
    expect(compileCommandPrompt).toHaveBeenLastCalledWith({
      redactedText: 'How private is it?',
      helpContext: null,
      signal: expect.any(AbortSignal)
    });
    expect(executeLocalLedgerQuery).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    submit('What can people see?');
    await waitFor(() => expect(answer).toHaveTextContent('commandAiHelpVerifyTitle'));
    expect(answer).toHaveTextContent('Check the Public or Private choice before you send.');
    expect(compileCommandPrompt).toHaveBeenCalledTimes(3);
    expect(compileCommandPrompt).toHaveBeenLastCalledWith({
      redactedText: 'What can people see?',
      helpContext: 'Privacy',
      signal: expect.any(AbortSignal)
    });
  });

  it('keeps the prior answer and submit controls mounted while the next question is pending', async () => {
    jest
      .mocked(compileCommandPrompt)
      .mockResolvedValueOnce({
        op: 'query_ledger',
        query: 'balance',
        asset: null,
        counterparty_ref: null,
        direction: 'all',
        window: 'all_time'
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    jest.mocked(executeLocalLedgerQuery).mockResolvedValue({
      query: 'balance',
      titleKey: 'commandAiQueryBalanceTitle',
      summaryText: '25 MIDEN',
      empty: false,
      rows: []
    });
    renderBar();
    const input = screen.getByTestId('command-ai-input');
    const button = screen.getByTestId('command-ai-submit');
    const label = screen.getByText('commandAiSendButton');
    const form = input.closest('form')!;
    fireEvent.change(input, { target: { value: 'What is my balance?' } });
    fireEvent.submit(form);
    const answer = await screen.findByTestId('command-ai-query-result');
    fireEvent.change(input, { target: { value: 'How much did I send?' } });
    fireEvent.submit(form);
    expect(screen.getByTestId('command-ai-query-result')).toBe(answer);
    expect(screen.getByTestId('command-ai-input')).toBe(input);
    expect(screen.getByTestId('command-ai-submit')).toBe(button);
    expect(screen.getByText('commandAiSendButton')).toBe(label);
    expect(button).toBeDisabled();
  });

  it('renders full-width 1-line bar directly above the portfolio and chart surface', async () => {
    render(<CommandPortfolio scope={scope} />);
    await waitFor(() => expect(screen.getByTestId('command-history')).toHaveAttribute('aria-busy', 'false'));
    const bar = screen.getByTestId('command-ai-bar');
    const surface = screen.getByTestId('command-portfolio-surface');
    expect(bar).toHaveClass('lg:col-span-12');
    expect(bar.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('command-ai-input').tagName).toBe('INPUT');
  });

  it('morphs cleanly between 1-line input and multi-line composer', () => {
    renderBar();
    expect(screen.getByTestId('command-ai-input').tagName).toBe('INPUT');
    fireEvent.click(screen.getByTestId('command-ai-morph-toggle'));
    expect(screen.getByTestId('command-ai-input').tagName).toBe('TEXTAREA');
    fireEvent.click(screen.getByTestId('command-ai-morph-toggle'));
    expect(screen.getByTestId('command-ai-input').tagName).toBe('INPUT');
  });

  it('redacts sensitive values before calling compiler and navigates straight to /send/review', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValue({
      op: 'set_intent',
      action: 'send',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'MIDEN',
      to_asset: null,
      from_chain: null,
      to_chain: null,
      recipient_ref: 'CONTACT_1',
      provider: null,
      note_type: null,
      earn_op: null
    });
    const { readDraft } = renderBar();
    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'send 10 MIDEN to Alice' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const req = jest.mocked(compileCommandPrompt).mock.calls[0]![0];
    expect(req.redactedText).toBe('send <AMT_1> MIDEN to <CONTACT_1>');
    expect(req.redactedText).not.toContain('10');
    expect(req.redactedText).not.toContain('Alice');
    expect(req.redactedText).not.toContain(ALICE_ADDR);

    expect(jest.mocked(navigate).mock.calls[0]![0]).toContain('/send/review?');
    expect(readDraft()('send')).toMatchObject({
      amount: '10',
      recipientAddress: ALICE_ADDR,
      tokenId: 'faucet-miden',
      privacy: 'private'
    });
  });

  it('surfaces bridge chips and prefills Bridge on chip click with zero extra LLM calls', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValue({
      op: 'set_intent',
      action: 'bridge',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'USDC',
      to_asset: null,
      from_chain: null,
      to_chain: 'miden',
      recipient_ref: null,
      provider: null,
      note_type: null,
      earn_op: null
    });
    const { readDraft } = renderBar();
    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'bridge 500 usdc to miden' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

    await screen.findByTestId('command-ai-clarification');
    expect(compileCommandPrompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('command-ai-chip-testnet:epoch:usdc:faucet-usdcx:receive')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'USDC → USDCx · agglayer (sepolia → miden-testnet)' }));
    expect(compileCommandPrompt).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/bridge/deposit');
    expect(readDraft()('bridge')).toMatchObject({
      direction: 'in',
      route: 'testnet:agglayer:usdc:faucet-usdcx:receive',
      amount: '500',
      autoReview: true
    });
  });

  it.each(['receive', 'send'] as const)('disambiguates duplicate bridge route labels in %s mode', async mode => {
    const provider = mode === 'receive' ? 'agglayer' : 'epoch';
    const first = '0xaaaaa' + '1'.repeat(31) + 'bbbb';
    const second = '0xaaaaa' + '2'.repeat(31) + 'bbbb';
    const distinct = '0xccccc' + '0'.repeat(31) + 'dddd';
    const miden = {
      kind: 'miden',
      network: 'miden-testnet',
      symbol: 'ETH',
      decimals: 18,
      faucetId: 'faucet-eth'
    } as const;
    const routeId = (address?: string) => `testnet:${provider}:${address ?? 'native'}:faucet-eth:${mode}`;
    mockBridgeRoutes = [undefined, first, second, distinct].map(address => {
      const evm = {
        ...(address ? ({ kind: 'erc20', address } as const) : ({ kind: 'native' } as const)),
        network: 'sepolia',
        symbol: 'ETH',
        decimals: 18
      };
      return {
        id: routeId(address),
        provider,
        mode,
        source: mode === 'receive' ? evm : miden,
        destination: mode === 'receive' ? miden : evm
      };
    });
    const toChain = mode === 'receive' ? 'miden' : 'sepolia';
    jest.mocked(compileCommandPrompt).mockResolvedValue({
      op: 'set_intent',
      action: 'bridge',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'ETH',
      to_asset: null,
      from_chain: null,
      to_chain: toChain,
      recipient_ref: null,
      provider: null,
      note_type: null,
      earn_op: null
    });
    const { readDraft } = renderBar();
    const input = screen.getByTestId('command-ai-input');
    fireEvent.change(input, { target: { value: `bridge 500 eth to ${toChain}` } });
    fireEvent.submit(input.closest('form')!);

    const chips = within(await screen.findByTestId('command-ai-clarification'));
    const direction = mode === 'receive' ? 'sepolia → miden-testnet' : 'miden-testnet → sepolia';
    const label = `ETH → ETH · ${provider} (${direction})`;
    const firstChip = chips.getByRole('button', { name: `${label} ${first}` });
    expect(chips.getByRole('button', { name: `${label} ${second}` })).toBeInTheDocument();
    expect(chips.getByRole('button', { name: `${label} 0xccccc…dddd` })).toBeInTheDocument();
    expect(chips.getByRole('button', { name: label })).toBeInTheDocument();

    fireEvent.click(firstChip);
    expect(readDraft()('bridge')).toMatchObject({ route: routeId(first) });
    expect(compileCommandPrompt).toHaveBeenCalledTimes(1);
  });

  it('shows contact prefix disambiguation for 0x02323 without padding hex', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValue({
      op: 'set_intent',
      action: 'send',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'MIDEN',
      to_asset: null,
      from_chain: null,
      to_chain: null,
      recipient_ref: 'ADDR_1',
      provider: null,
      note_type: null,
      earn_op: null
    });
    renderBar();
    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'send 1 MIDEN to 0x02323' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

    const clarification = await screen.findByTestId('command-ai-clarification');
    expect(clarification.textContent).toContain('0x02323');
    expect(
      screen.getByTestId('command-ai-chip-contact:0x023230000000000000000000000000000000a9f1')
    ).toBeInTheDocument();
  });

  it('renders local ledger query results inline with zero balances leaked', async () => {
    jest.mocked(compileCommandPrompt).mockResolvedValue({
      op: 'query_ledger',
      query: 'tx_sum',
      asset: null,
      counterparty_ref: 'CONTACT_1',
      direction: 'out',
      window: 'prev_month'
    });
    jest.mocked(executeLocalLedgerQuery).mockResolvedValue({
      query: 'tx_sum',
      titleKey: 'commandAiQueryTotalTitle',
      summaryText: '15 MIDEN',
      empty: false,
      rows: [{ id: 'tx-1', primaryText: 'send · 15 MIDEN', secondaryText: '10/20/2026' }]
    });
    renderBar();
    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'how much did I send Alice last month?' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

    const card = await screen.findByTestId('command-ai-query-result');
    expect(card.textContent).toContain('15 MIDEN');
    const req = jest.mocked(compileCommandPrompt).mock.calls[0]![0];
    expect(req.redactedText).toBe('how much did I send <CONTACT_1> last month?');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('passes USDCx earn collateral rather than native gas faucet ID for earn deposits', async () => {
    mockEarnVaultCatalog = [
      {
        listing: { id: 'vault-usdc', name: 'Epoch USDC', protocol: 'aave', marketUid: 'mkt-1' },
        underlying: { symbol: 'USDC', address: '0x1', decimals: 6 },
        lenderName: 'Aave V3',
        chainId: '11155111',
        aprTotal: 5.2
      }
    ];
    mockMidenUsdcFaucetId = 'faucet-usdcx-earn';

    jest.mocked(compileCommandPrompt).mockResolvedValue({
      op: 'set_intent',
      action: 'earn',
      amount: { kind: 'exact_ref', ref: 'AMT_1' },
      asset: 'USDC',
      to_asset: null,
      from_chain: null,
      to_chain: null,
      recipient_ref: null,
      provider: null,
      note_type: null,
      earn_op: 'deposit'
    });
    renderBar();
    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'deposit 50 USDC into earn' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(jest.mocked(navigate).mock.calls[0]![0]).toBe(
      '/earn/vaults/vault-usdc/deposit/review?amount=50&collateral=faucet-usdcx-earn'
    );
  });

  it('rejects stale turn-1 placeholder refs during a fresh follow-up ledger query', async () => {
    jest
      .mocked(compileCommandPrompt)
      .mockResolvedValueOnce({
        op: 'set_intent',
        action: 'send',
        amount: null,
        asset: 'MIDEN',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'CONTACT_1',
        provider: null,
        note_type: null,
        earn_op: null
      })
      .mockResolvedValueOnce({
        op: 'query_ledger',
        query: 'tx_sum',
        asset: null,
        counterparty_ref: 'CONTACT_1',
        direction: 'out',
        window: 'all_time'
      });
    renderBar();

    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'send MIDEN to Alice' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);
    await screen.findByTestId('command-ai-clarification');

    // Turn 2 prompt has no contact ref, yet model tries to reference CONTACT_1 from turn 1.
    fireEvent.change(screen.getByTestId('command-ai-input'), {
      target: { value: 'how much did I spend overall?' }
    });
    fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

    const alert = await screen.findByTestId('command-ai-error');
    expect(alert.textContent).toContain('commandAiInvalidModelOutput');
    expect(useUserVisibleError).toHaveBeenLastCalledWith('raw_command_ai_failed', 'inline');
    expect(executeLocalLedgerQuery).not.toHaveBeenCalled();
  });

  it('shows multi-step plan card with animated Bread mascot, steps through Bridge -> Swap, and supports Stop', async () => {
    _setSwapTokensForTest([
      { symbol: 'USDCx', faucetId: 'faucet-usdcx', decimals: 6 },
      { symbol: 'MIDEN', faucetId: 'faucet-miden', decimals: 6 }
    ]);
    try {
      jest.mocked(compileCommandPrompt).mockResolvedValue({
        op: 'set_plan',
        steps: [
          {
            action: 'bridge',
            amount: { kind: 'exact_ref', ref: 'AMT_1' },
            asset: 'USDC',
            to_asset: null,
            from_chain: null,
            to_chain: 'miden',
            recipient_ref: null,
            provider: null,
            note_type: null,
            earn_op: null
          },
          {
            action: 'swap',
            amount: { kind: 'previous_output' },
            asset: 'USDCx',
            to_asset: 'MIDEN',
            from_chain: null,
            to_chain: null,
            recipient_ref: null,
            provider: null,
            note_type: null,
            earn_op: null
          }
        ]
      });

      const view = renderBar();
      fireEvent.change(screen.getByTestId('command-ai-input'), {
        target: { value: 'bridge 50 usdc in, then swap it for MIDEN' }
      });
      fireEvent.submit(screen.getByTestId('command-ai-input').closest('form')!);

      await screen.findByTestId('command-ai-plan-card');
      expect(screen.getByTestId('bread-mascot')).toBeInTheDocument();
      expect(screen.getByTestId('command-ai-plan-step-0')).toBeInTheDocument();
      expect(screen.getByTestId('command-ai-plan-step-1')).toBeInTheDocument();

      // Click bridge route chip -> navigates to Step 1 workbench and updates draft.
      fireEvent.click(screen.getByTestId('command-ai-chip-testnet:agglayer:usdc:faucet-usdcx:receive'));
      expect(navigate).toHaveBeenCalledWith('/bridge/deposit');
      expect(view.readDraft()('bridge')).toMatchObject({ amount: '50', direction: 'in' });

      // Simulate active workbench route -> persistent banner appears with Next step & Stop.
      view.rerender(
        <CommandDraftProvider scope={scope}>
          <CommandAiPlanProvider scope={scope}>
            <CommandAiPlanBanner scope={scope} route={{ kind: 'flow', action: 'bridge' }} />
            <CommandAiBar scope={scope} assets={assets} tokenPrices={{}} />
          </CommandAiPlanProvider>
        </CommandDraftProvider>
      );

      // Advance to Step 2 -> opens Swap prefilled with carried amount 50.
      fireEvent.click(screen.getByTestId('command-ai-plan-banner-next'));
      expect(navigate).toHaveBeenCalledWith('/swap');
      expect(view.readDraft()('swap')).toMatchObject({
        payAmount: '50',
        payTokenId: 'faucet-usdcx',
        receiveTokenId: 'faucet-miden'
      });

      // Stop cancels plan cleanly and returns to '/'.
      fireEvent.click(screen.getByTestId('command-ai-plan-banner-stop'));
      expect(navigate).toHaveBeenLastCalledWith('/');
      expect(screen.queryByTestId('command-ai-plan-banner')).not.toBeInTheDocument();
    } finally {
      _setSwapTokensForTest(undefined);
    }
  });

  it('cycles animated sample prompt placeholders while empty and stops when typing', () => {
    jest.useFakeTimers();
    try {
      const { rerender } = render(<CommandAiBar scope={scope} assets={assets} tokenPrices={{}} />);
      const input = () => screen.getByTestId('command-ai-input') as HTMLInputElement;
      const step = (ms: number, times = 1) => {
        for (let i = 0; i < times; i += 1) {
          act(() => {
            jest.advanceTimersByTime(ms);
          });
        }
      };
      expect(input().placeholder).toBe('');

      step(48, 5);
      expect(input().placeholder).toBe('comma|');

      step(48, 17);
      expect(input().placeholder).toBe('commandAiSamplePrompt1|');

      step(2200);
      step(24, 22);
      expect(input().placeholder).toBe('');

      step(450);
      step(48, 22);
      expect(input().placeholder).toBe('commandAiSamplePrompt2|');

      // Focusing hides the placeholder and pauses timer progression; blurring resumes it.
      fireEvent.focus(input());
      expect(input().placeholder).toBe('');
      step(24, 10);
      expect(input().placeholder).toBe('');
      fireEvent.blur(input());
      expect(input().placeholder).toBe('commandAiSamplePrompt2|');
      step(2200);
      step(24);
      expect(input().placeholder).toBe('commandAiSamplePrompt|');

      fireEvent.change(input(), { target: { value: 'hello' } });
      expect(input().placeholder).toBe('commandAiPlaceholder');
      rerender(<CommandAiBar scope={scope} assets={assets} tokenPrices={{}} />);
      step(48, 5);
      expect(input().placeholder).toBe('commandAiPlaceholder');
    } finally {
      jest.useRealTimers();
    }
  });
});
