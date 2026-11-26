import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';

import { executeLocalLedgerQuery } from './local-query';
import { redactPrompt } from './redactor';

jest.mock('lib/miden/swap/tokens', () => ({
  tokenQuote: (_prices: unknown, id: string) =>
    id === 'faucet-miden' ? { price: 2, change24h: 0, observedAt: Date.now() } : undefined
}));

const balances: TokenBalanceData[] = [
  {
    tokenId: 'faucet-miden',
    tokenSlug: 'MIDEN',
    balance: 12.5,
    balanceBaseUnits: '12500000',
    fiatPrice: 2,
    change24h: 0,
    metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6 }
  },
  {
    tokenId: 'faucet-usdcx',
    tokenSlug: 'USDCx',
    balance: 100,
    balanceBaseUnits: '100000000',
    fiatPrice: 1,
    change24h: 0,
    metadata: { symbol: 'USDCx', name: 'USDCx', decimals: 6 }
  }
];

const contacts = [{ id: 'c-alice', name: 'Alice', address: 'mtst1alice' }];

describe('command-ai local query engine', () => {
  it('computes single-asset and total balances locally without network egress', async () => {
    const { map } = redactPrompt('how much MIDEN do I have?', { contacts });
    const res = await executeLocalLedgerQuery(
      {
        op: 'query_ledger',
        query: 'balance',
        asset: 'MIDEN',
        counterparty_ref: null,
        direction: 'all',
        window: 'all_time'
      },
      {
        accountId: 'mtst1me',
        balances,
        tokenPrices: {
          MIDEN: { price: 2, change24h: 0, percentageChange24h: 0, kind: 'market', observedAt: Date.now() }
        },
        map
      }
    );

    expect(res.empty).toBe(false);
    expect(res.summaryText).toContain('12.5 MIDEN');
    expect(res.summaryText).toContain('25.00 USD');
  });

  it('aggregates outgoing transfers to a contact within the requested window using exact bigint math', async () => {
    const nowMs = new Date(2026, 10, 25, 12, 0, 0).getTime();
    const thisMonthSec = Math.floor(new Date(2026, 10, 10, 12, 0, 0).getTime() / 1000);
    const lastMonthSec = Math.floor(new Date(2026, 9, 10, 12, 0, 0).getTime() / 1000);

    const txs = [
      {
        id: 'tx-1',
        type: 'send',
        accountId: 'mtst1me',
        secondaryAccountId: 'mtst1alice',
        faucetId: 'faucet-miden',
        amount: 3_500_000n,
        status: ITransactionStatus.Completed,
        initiatedAt: thisMonthSec,
        displayIcon: 'SEND'
      },
      {
        id: 'tx-2',
        type: 'send',
        accountId: 'mtst1me',
        secondaryAccountId: 'mtst1alice',
        faucetId: 'faucet-miden',
        amount: 1_500_000n,
        status: ITransactionStatus.Completed,
        initiatedAt: thisMonthSec + 60,
        displayIcon: 'SEND'
      },
      {
        id: 'tx-failed',
        type: 'send',
        accountId: 'mtst1me',
        secondaryAccountId: 'mtst1alice',
        faucetId: 'faucet-miden',
        amount: 99_000_000n,
        status: ITransactionStatus.Failed,
        initiatedAt: thisMonthSec + 120,
        displayIcon: 'SEND'
      },
      {
        id: 'tx-prev-month',
        type: 'send',
        accountId: 'mtst1me',
        secondaryAccountId: 'mtst1alice',
        faucetId: 'faucet-miden',
        amount: 50_000_000n,
        status: ITransactionStatus.Completed,
        initiatedAt: lastMonthSec,
        displayIcon: 'SEND'
      }
    ] as unknown as ITransaction[];

    const { map } = redactPrompt('how much did I send Alice this month?', { contacts });
    const res = await executeLocalLedgerQuery(
      {
        op: 'query_ledger',
        query: 'tx_sum',
        asset: null,
        counterparty_ref: 'CONTACT_1',
        direction: 'out',
        window: 'this_month'
      },
      {
        accountId: 'mtst1me',
        balances,
        tokenPrices: {},
        map,
        nowMs,
        readAccountTransactions: async () => txs
      }
    );

    expect(res.empty).toBe(false);
    expect(res.summaryText).toBe('5 MIDEN');
    expect(res.rows).toHaveLength(2);
  });
});
