import type { MainnetNearCheckpoint } from '../../playwright/e2e/helpers/mainnet-near-checkpoint';
export function nativeNearFixture(): MainnetNearCheckpoint {
  return { version: 2, network: 'mainnet', account: 'mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5_qr7qqq9wr6w',
    accountHex: '0x593c167bec26769178dcbd1f9bcb40', sourceRunId: '100', authorizationRunId: '100',
    phase: 'forward-authorized', createdAt: '2026-11-12T12:00:00.000Z', pricedAt: '2026-11-12T12:00:00.000Z', updatedAt: '2026-11-12T12:00:00.000Z',
    native: { faucetId: 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24_qr7qqq9wr6w', hex: '0xe69e6ca6e39df1b10c1e5399399feb',
      symbol: 'USDCX', decimals: 6, balance: '20000000', usdMicros: '1000000' },
    evm: { chainId: 42161, account: `0x${'1'.repeat(40)}`, token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      tokenBalance: '3000000', nativeBalance: '10000000000000000', tokenUsdMicros: '1000000', nativeUsdMicros: '2000000000' },
    nativeAssetId: 'nep141:miden-0xe69e6ca6e39df1b10c1e5399399feb.omft.near',
    evmAssetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    serviceUrl: 'https://1click.chaindefuser.com', appFees: [],
    feePolicy: { kind: 'partner', platformRecipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', minimumPlatformFeeBps: 20 },
    baseFee: '7', principal: '1010000', forwardMinimum: '1000000', reverseMinimum: '1000000',
    lossBudgetUsdMicros: '1999095', feeBudget: '1000', evmFeeBudget: '1000000000000', paidMidenFees: '0', paidEvmFees: '0' };
}
export const nativeNearQuote = (depositAddress: string, amountIn: string) => ({ quoteHash: '2'.repeat(44), correlationId: 'original-provider-quote',
  depositAddress, amountIn, minimumOutput: '1000000', refundFee: '10000', deadline: '2026-11-12T12:05:00.000Z' });
