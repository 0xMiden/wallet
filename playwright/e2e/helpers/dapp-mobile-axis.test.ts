/**
 * @jest-environment node
 */
import { deadlineIn, InfrastructureFault } from './dapp-cells';
import { mobileGuardianAxis } from './dapp-mobile-axis';
import type { MobileWallet } from './dapp-mobile-wallet';

jest.mock('@playwright/test', () => ({ expect: { any: (type: unknown) => ({ any: type }) } }));

const URL_A = 'http://guardian.test:3000';
const FAST = { endpointMs: 50, settleMs: 40, pollMs: 5 };

// A webview stand-in: sync reads answer the store's Guardian endpoint; stashed reads answer the operator's views in
// turn, through the stash protocol mobile-store-reads.ts speaks.
function walletWith(endpoints: string[], views: Array<{ commitment?: string; error?: string }>) {
  const operatorCalls: string[] = [];
  let stash: unknown = null;
  const wallet = {
    createGuardianWallet: jest.fn(async () => ({ address: 'mtst1guardian', seedPhrase: [] })),
    evalJs: jest.fn(async (js: string) => {
      if (js.includes('guardianEndpoint')) return endpoints.length > 1 ? endpoints.shift() : endpoints[0];
      if (js.includes('__TEST_GUARDIAN_OPERATOR_VIEW__')) {
        operatorCalls.push(js);
        stash = { ok: true, v: views.length > 1 ? views.shift() : views[0] };
        return null;
      }
      const read = stash;
      stash = null;
      return read;
    })
  };
  return { wallet: wallet as unknown as MobileWallet, operatorCalls };
}

describe('the mobile Guardian axis', () => {
  it('creates a Guardian account and waits until the store names its operator', async () => {
    const { wallet } = walletWith(['', '', URL_A], []);
    await expect(mobileGuardianAxis(URL_A, { ...FAST, endpointMs: 5_000 }).create(wallet)).resolves.toEqual({
      address: 'mtst1guardian',
      seedPhrase: []
    });
  });

  it('refuses an account whose operator stays another one', async () => {
    const { wallet } = walletWith(['http://wrong.test:3000'], []);
    await expect(mobileGuardianAxis(URL_A, FAST).create(wallet)).rejects.toThrow(
      'Guardian endpoint is http://wrong.test:3000, expected http://guardian.test:3000'
    );
  });

  it('settles once the operator holds the chain commitment', async () => {
    const { wallet, operatorCalls } = walletWith(
      [],
      [{ commitment: '0xaa' }, { commitment: '0xaa' }, { commitment: '0xBB' }]
    );
    await mobileGuardianAxis(URL_A, { ...FAST, settleMs: 5_000 }).settle(
      wallet,
      'mtst1a',
      '0xbb',
      deadlineIn(10_000, 'cell')
    );
    expect(operatorCalls).toHaveLength(3);
  });

  it('keeps waiting while the operator holds the previous commitment, then fails as infrastructure', async () => {
    const { wallet } = walletWith([], [{ commitment: '0xaa' }]);
    await expect(
      mobileGuardianAxis(URL_A, FAST).settle(wallet, 'mtst1a', '0xbb', deadlineIn(10_000, 'cell'))
    ).rejects.toBeInstanceOf(InfrastructureFault);
  });

  it('settles nothing for an account the chain has never seen', async () => {
    const { wallet, operatorCalls } = walletWith([], [{ commitment: '0xaa' }]);
    await mobileGuardianAxis(URL_A, FAST).settle(wallet, 'mtst1a', null, deadlineIn(10_000, 'cell'));
    expect(operatorCalls).toEqual([]);
  });
});
