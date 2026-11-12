import type { MainnetEpochCheckpoint } from '../../playwright/e2e/helpers/mainnet-epoch-checkpoint';

export function epochReverseAuthorityFixture() {
  const minimumExpiry = BigInt(Date.parse('2026-11-11T13:00:00.000Z') / 1000);
  return {
    arbiter: `0x${'4'.repeat(40)}`,
    lockTag: `0x50${'2'.repeat(22)}`,
    preparedAt: '2026-11-11T12:10:00.000Z',
    valuation: { pricedAt: '2026-11-11T12:10:00.000Z', stableUsdMicros: '1000000', gasUsdMicros: '2000000000' },
    minimumExpiry: minimumExpiry.toString(),
    maximumExpiry: (minimumExpiry + 300n).toString()
  };
}

export function epochCheckpointFixture(): MainnetEpochCheckpoint {
  return {
    version: 1,
    network: 'mainnet',
    account: `mm1${'a'.repeat(38)}`,
    accountHex: `0x${'12'.repeat(15)}`,
    sourceRunId: '100',
    authorizationRunId: '100',
    phase: 'forward-authorized',
    createdAt: '2026-11-11T12:00:00.000Z',
    pricedAt: '2026-11-11T12:00:00.000Z',
    updatedAt: '2026-11-11T12:00:00.000Z',
    native: {
      faucetId: 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24',
      hex: '0xe69e6ca6e39df1b10c1e5399399feb',
      symbol: 'USDCX',
      decimals: 6,
      balance: '20000000',
      usdMicros: '1000000'
    },
    evm: {
      chainId: 42161,
      account: `0x${'1'.repeat(40)}`,
      token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      allocator: `0x${'2'.repeat(40)}`,
      compact: `0x${'3'.repeat(40)}`,
      tokenBalance: '3000000',
      nativeBalance: '10000000000000000',
      tokenUsdMicros: '1000000',
      nativeUsdMicros: '2000000000'
    },
    allocatorUrl: 'https://mainnet-api.epochprotocol.xyz',
    virtualChainId: 999,
    midenAllocator: '0x593c167bec26769178dcbd1f9bcb40',
    recallBlocks: 6200,
    minimumRecallBlocks: 5200,
    principal: '1010000',
    forwardMinimum: '1000000',
    reverseMinimum: '1000000',
    lossBudgetUsdMicros: '1999095',
    feeBudget: '1000',
    evmFeeBudget: '1000000000000',
    paidMidenFees: '0',
    paidEvmFees: '0',
    forwardNonce: '9'
  };
}
